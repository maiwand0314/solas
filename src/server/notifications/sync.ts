import "server-only";
import { sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import type { Queryable } from "@/server/tasks/lifecycle";

// The notification sync (M6B), run by the worker every few seconds.
//
// Notifications are derived, never the source of truth: each one is a
// readable summary of something that already happened in another table (a
// failed task, a missed or paused automation run, a tool call that needs a
// decision). The sync looks at those rows and inserts a notification for each
// event it hasn't seen, using INSERT ... SELECT ... ON CONFLICT DO NOTHING on
// the event's dedupe key. So:
//
//   - running it twice, or in two workers at once, makes no duplicates;
//   - a worker that was stopped catches up on restart (the events are in the
//     database, not in memory);
//   - nothing is created for events older than the lookback window, so the
//     first run after an upgrade doesn't bury the owner in old history.
//
// Text is written here from stored facts (names, codes, Solas's own messages),
// never from tool input or model output, so it can't carry credentials.

/** How far back the sync looks for events it hasn't recorded. */
export const NOTIFICATION_LOOKBACK_HOURS = 48;

export type SyncResult = { created: number };

const WINDOW = sql.raw(`interval '${NOTIFICATION_LOOKBACK_HOURS} hours'`);

export async function syncNotifications(db: Queryable): Promise<SyncResult> {
  const results = await Promise.all([failedTasks(db), automationEvents(db), approvals(db)]);
  return { created: results.reduce((sum, count) => sum + count, 0) };
}

/** Creates the notifications a worker loop would; exposed so tests can run one pass. */
export function createNotificationSync(db: Database) {
  return { sync: () => syncNotifications(db) };
}

async function insert(db: Queryable, query: ReturnType<typeof sql>): Promise<number> {
  const rows = await db.execute<{ id: string }>(query);
  return rows.length;
}

/** A task that failed, or was interrupted (a lost worker that wasn't safe to repeat). */
async function failedTasks(db: Queryable) {
  return insert(
    db,
    sql`
    insert into notifications (kind, dedupe_key, title, body, task_id, automation_id, occurred_at)
    select
      case when t.status = 'interrupted' then 'task_interrupted' else 'task_failed' end,
      -- finished_at is part of the key: a retry that fails again is a new event
      'task:' || t.id || ':' || t.status || ':' || extract(epoch from t.finished_at)::text,
      case when t.status = 'interrupted' then 'Task interrupted: ' else 'Task failed: ' end || left(t.title, 120),
      left(coalesce(t.error_message, ''), 300),
      t.id,
      t.automation_id,
      t.finished_at
    from tasks t
    where t.status in ('failed', 'interrupted')
      and t.finished_at is not null
      and t.finished_at > now() - ${WINDOW}
    on conflict (dedupe_key) do nothing
    returning id`,
  );
}

/** Runs of an automation that were missed, or that Solas couldn't start because the owner must act. */
async function automationEvents(db: Queryable) {
  const missed = await insert(
    db,
    sql`
    insert into notifications (kind, dedupe_key, title, body, automation_id, occurred_at)
    select 'automation_missed', 'occurrence:' || o.id, 'Missed run: ' || left(a.name, 120), left(o.message, 300), a.id, o.scheduled_for
    from automation_occurrences o
    join automations a on a.id = o.automation_id
    where o.status = 'missed' and o.created_at > now() - ${WINDOW}
    on conflict (dedupe_key) do nothing
    returning id`,
  );
  // Overlap and the usage caps are the safeguards working as designed, so they stay in the
  // automation's history only. These reasons mean something is broken or stopped.
  const skipped = await insert(
    db,
    sql`
    insert into notifications (kind, dedupe_key, title, body, automation_id, occurred_at)
    select
      case when o.reason = 'paused_after_failures' then 'automation_paused' else 'automation_skipped' end,
      'occurrence:' || o.id,
      case when o.reason = 'paused_after_failures' then 'Automation paused: ' else 'Run skipped: ' end || left(a.name, 120),
      left(o.message, 300),
      a.id,
      o.created_at
    from automation_occurrences o
    join automations a on a.id = o.automation_id
    where o.status = 'skipped'
      and o.reason in ('agent_unavailable', 'team_unavailable', 'paused_after_failures')
      and o.created_at > now() - ${WINDOW}
    on conflict (dedupe_key) do nothing
    returning id`,
  );
  return missed + skipped;
}

/**
 * Approvals (tool calls that wait for the owner). A request is announced
 * while it is still open; an expired or rejected one is announced when it
 * happens. Approving needs no notification: the owner just did it. The
 * notification never says what was approved beyond the tool's name: the
 * owner reviews the request itself on the linked page.
 */
async function approvals(db: Queryable) {
  const base = sql`
    from tool_calls c
    join runs r on r.id = c.run_id
    join agents g on g.id = r.agent_id
    where c.requires_approval and c.created_at > now() - ${WINDOW}`;
  const requested = await insert(
    db,
    sql`
    insert into notifications (kind, dedupe_key, title, body, task_id, conversation_id, tool_call_id, occurred_at)
    select 'approval_requested', 'approval_requested:' || c.id, 'Approval needed: ' || left(g.name, 80),
      left(g.name, 80) || ' wants to use ' || c.tool_id || '. Review the request and approve or reject it.',
      r.task_id, r.conversation_id, c.id, c.created_at
    ${base} and c.status = 'awaiting_approval' and c.approval_expires_at > now()
    on conflict (dedupe_key) do nothing
    returning id`,
  );
  const expired = await insert(
    db,
    sql`
    insert into notifications (kind, dedupe_key, title, body, task_id, conversation_id, tool_call_id, occurred_at)
    select 'approval_expired', 'approval_expired:' || c.id, 'Approval expired: ' || left(g.name, 80),
      'The request to use ' || c.tool_id || ' wasn’t answered in time, so it did not run.',
      r.task_id, r.conversation_id, c.id, coalesce(c.finished_at, c.approval_expires_at, c.created_at)
    ${base} and c.status = 'expired'
    on conflict (dedupe_key) do nothing
    returning id`,
  );
  const rejected = await insert(
    db,
    sql`
    insert into notifications (kind, dedupe_key, title, body, task_id, conversation_id, tool_call_id, occurred_at)
    select 'approval_rejected', 'approval_rejected:' || c.id, 'Approval rejected: ' || left(g.name, 80),
      'The request to use ' || c.tool_id || ' was rejected, so it did not run.',
      r.task_id, r.conversation_id, c.id, coalesce(c.decided_at, c.created_at)
    ${base} and c.status = 'rejected'
    on conflict (dedupe_key) do nothing
    returning id`,
  );
  return requested + expired + rejected;
}
