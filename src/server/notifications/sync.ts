import "server-only";
import { sql, type SQL } from "drizzle-orm";
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
//
// Preferences (M6C): a kind the owner muted creates nothing. When it is turned
// back on, only events after that moment count (notification_preferences.
// changed_at), so the muted period is never replayed. The filter sits in the
// same INSERT, so deduplication and restart safety are unchanged.

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

type Column = "kind" | "dedupe_key" | "title" | "body" | "task_id" | "automation_id" | "conversation_id" | "tool_call_id" | "occurred_at";

/**
 * Inserts the events `select` finds (its columns aliased to `columns`),
 * except those of a muted kind or from before a kind was turned back on.
 */
async function insert(db: Queryable, columns: Column[], select: SQL): Promise<number> {
  const list = sql.raw(columns.join(", "));
  const rows = await db.execute<{ id: string }>(sql`
    insert into notifications (${list})
    select ${list} from (${select}) e
    where not exists (
      select 1 from notification_preferences p
      where p.kind = e.kind and (not p.enabled or e.occurred_at <= p.changed_at)
    )
    on conflict (dedupe_key) do nothing
    returning id`);
  return rows.length;
}

/** A task that failed, or was interrupted (a lost worker that wasn't safe to repeat). */
async function failedTasks(db: Queryable) {
  return insert(
    db,
    ["kind", "dedupe_key", "title", "body", "task_id", "automation_id", "occurred_at"],
    sql`
    select
      case when t.status = 'interrupted' then 'task_interrupted' else 'task_failed' end as kind,
      -- finished_at is part of the key: a retry that fails again is a new event
      'task:' || t.id || ':' || t.status || ':' || extract(epoch from t.finished_at)::text as dedupe_key,
      case when t.status = 'interrupted' then 'Task interrupted: ' else 'Task failed: ' end || left(t.title, 120) as title,
      left(coalesce(t.error_message, ''), 300) as body,
      t.id as task_id,
      t.automation_id,
      t.finished_at as occurred_at
    from tasks t
    where t.status in ('failed', 'interrupted')
      and t.finished_at is not null
      and t.finished_at > now() - ${WINDOW}`,
  );
}

/** Runs of an automation that were missed, or that Solas couldn't start because the owner must act. */
async function automationEvents(db: Queryable) {
  const columns: Column[] = ["kind", "dedupe_key", "title", "body", "automation_id", "occurred_at"];
  const missed = await insert(
    db,
    columns,
    sql`
    select 'automation_missed' as kind, 'occurrence:' || o.id as dedupe_key, 'Missed run: ' || left(a.name, 120) as title,
      left(o.message, 300) as body, a.id as automation_id, o.scheduled_for as occurred_at
    from automation_occurrences o
    join automations a on a.id = o.automation_id
    where o.status = 'missed' and o.created_at > now() - ${WINDOW}`,
  );
  // Overlap and the usage caps are the safeguards working as designed, so they stay in the
  // automation's history only. These reasons mean something is broken or stopped.
  const skipped = await insert(
    db,
    columns,
    sql`
    select
      case when o.reason = 'paused_after_failures' then 'automation_paused' else 'automation_skipped' end as kind,
      'occurrence:' || o.id as dedupe_key,
      case when o.reason = 'paused_after_failures' then 'Automation paused: ' else 'Run skipped: ' end || left(a.name, 120) as title,
      left(o.message, 300) as body,
      a.id as automation_id,
      o.created_at as occurred_at
    from automation_occurrences o
    join automations a on a.id = o.automation_id
    where o.status = 'skipped'
      and o.reason in ('agent_unavailable', 'team_unavailable', 'paused_after_failures')
      and o.created_at > now() - ${WINDOW}`,
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
  const columns: Column[] = ["kind", "dedupe_key", "title", "body", "task_id", "conversation_id", "tool_call_id", "occurred_at"];
  const requested = await insert(
    db,
    columns,
    sql`
    select 'approval_requested' as kind, 'approval_requested:' || c.id as dedupe_key, 'Approval needed: ' || left(g.name, 80) as title,
      left(g.name, 80) || ' wants to use ' || c.tool_id || '. Review the request and approve or reject it.' as body,
      r.task_id, r.conversation_id, c.id as tool_call_id, c.created_at as occurred_at
    ${base} and c.status = 'awaiting_approval' and c.approval_expires_at > now()`,
  );
  const expired = await insert(
    db,
    columns,
    sql`
    select 'approval_expired' as kind, 'approval_expired:' || c.id as dedupe_key, 'Approval expired: ' || left(g.name, 80) as title,
      'The request to use ' || c.tool_id || ' wasn’t answered in time, so it did not run.' as body,
      r.task_id, r.conversation_id, c.id as tool_call_id, coalesce(c.finished_at, c.approval_expires_at, c.created_at) as occurred_at
    ${base} and c.status = 'expired'`,
  );
  const rejected = await insert(
    db,
    columns,
    sql`
    select 'approval_rejected' as kind, 'approval_rejected:' || c.id as dedupe_key, 'Approval rejected: ' || left(g.name, 80) as title,
      'The request to use ' || c.tool_id || ' was rejected, so it did not run.' as body,
      r.task_id, r.conversation_id, c.id as tool_call_id, coalesce(c.decided_at, c.created_at) as occurred_at
    ${base} and c.status = 'rejected'`,
  );
  return requested + expired + rejected;
}
