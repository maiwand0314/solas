import "server-only";
import { and, count, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import type { AutomationLimitValues } from "@/lib/automations/limits";
import { formatInTimeZone } from "@/lib/automations/schedule";
import { ACTIVE_TASK_STATUSES } from "@/lib/tasks/status";
import {
  automationOccurrences,
  automations,
  runs,
  tasks,
  type AgentRow,
  type AutomationRow,
  type OccurrenceSkipReason,
} from "@/server/db/schema";
import { getAgentReadiness, type ProviderRegistry } from "@/server/providers/registry";
import { insertTaskWithFirstRun } from "@/server/tasks/create";
import type { Queryable } from "@/server/tasks/lifecycle";

// Starting one run of an automation, shared by the worker's scheduler and the
// owner's "Run now". A run becomes an ordinary task: the safeguards below
// decide whether it may start, and every outcome (started or skipped) is a
// row in automation_occurrences, identified by (automation, scheduled time).

export type AutomationLimits = Pick<
  AutomationLimitValues,
  "maxConcurrentExecutions" | "maxRunsPerDay" | "usageLimitCooldownMs" | "taskAutoRetries" | "missedAfterMs"
>;

export type StartCheck = { ok: true } | { ok: false; reason: OccurrenceSkipReason; message: string };

/**
 * Starts are serialised across every process with one transaction-scoped
 * advisory lock, so two schedulers (or a scheduler and Run now) can't both
 * pass the "how many are running" checks at the same moment. Held until the
 * transaction ends; always taken after the automation's row lock.
 */
const START_LOCK = 6_001_001;

/**
 * Whether a run may start now. In order: the agent can work, the
 * automation's previous run has finished (no overlap), Claude hasn't
 * reported a usage limit recently, and the concurrent and daily caps across
 * all automations aren't reached. Takes the start lock.
 */
export async function checkCanStart(
  tx: Queryable,
  { automation, agent, now, providers, limits }: {
    automation: AutomationRow;
    agent: AgentRow;
    now: Date;
    providers: ProviderRegistry;
    limits: AutomationLimits;
  },
): Promise<StartCheck> {
  await tx.execute(sql`select pg_advisory_xact_lock(${START_LOCK})`);

  const readiness = getAgentReadiness(agent, providers);
  if (readiness.state !== "ready") {
    const why = readiness.state === "disabled" ? "is disabled" : "has no available model";
    return skip("agent_unavailable", `Skipped: “${agent.name}” ${why}. Enable it or choose a model to let this automation run.`);
  }

  const active = inArray(tasks.status, [...ACTIVE_TASK_STATUSES]);
  const [{ running }] = await tx
    .select({ running: count() })
    .from(tasks)
    .where(and(eq(tasks.automationId, automation.id), active));
  if (running > 0) {
    return skip("overlap", "Skipped: the previous run of this automation hadn’t finished. Runs of one automation never overlap.");
  }

  const cooldownStart = new Date(now.getTime() - limits.usageLimitCooldownMs);
  const [limited] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.errorCode, "usage_limit"), gt(runs.finishedAt, cooldownStart)))
    .limit(1);
  if (limited) {
    const minutes = Math.round(limits.usageLimitCooldownMs / 60_000);
    return skip(
      "usage_limit",
      `Skipped: Claude reported a usage limit in the last ${minutes} minutes. Scheduled runs wait for it to reset instead of failing.`,
    );
  }

  const [{ concurrent }] = await tx
    .select({ concurrent: count() })
    .from(tasks)
    .where(and(isNotNull(tasks.automationId), active));
  if (concurrent >= limits.maxConcurrentExecutions) {
    return skip(
      "concurrency_limit",
      `Skipped: ${concurrent} automation ${concurrent === 1 ? "task was" : "tasks were"} already queued or running (the limit is ${limits.maxConcurrentExecutions}).`,
    );
  }

  const dayStart = new Date(now.getTime() - 24 * 60 * 60_000);
  const [{ today }] = await tx
    .select({ today: count() })
    .from(tasks)
    .where(and(isNotNull(tasks.automationId), gt(tasks.createdAt, dayStart)));
  if (today >= limits.maxRunsPerDay) {
    return skip(
      "daily_limit",
      `Skipped: automations already started ${today} tasks in the last 24 hours (the limit is ${limits.maxRunsPerDay}).`,
    );
  }
  return { ok: true };
}

function skip(reason: OccurrenceSkipReason, message: string): StartCheck {
  return { ok: false, reason, message };
}

/**
 * Records a started run and creates its task, in the caller's transaction.
 * Returns null if this run was already recorded (another scheduler got
 * there first): then nothing is created, so a run never makes two tasks.
 */
export async function startOccurrence(
  tx: Queryable,
  {
    automation,
    agent,
    scheduledFor,
    trigger,
    limits,
  }: {
    automation: AutomationRow;
    agent: AgentRow;
    scheduledFor: Date;
    trigger: "schedule" | "manual";
    limits: AutomationLimits;
  },
): Promise<{ occurrenceId: string; taskId: string } | null> {
  const when = formatInTimeZone(scheduledFor, automation.timeZone);
  const [occurrence] = await tx
    .insert(automationOccurrences)
    .values({
      automationId: automation.id,
      scheduledFor,
      trigger,
      status: "started",
      message: trigger === "manual" ? "You started this run with Run now." : `Started on schedule (${when}).`,
    })
    .onConflictDoNothing({ target: [automationOccurrences.automationId, automationOccurrences.scheduledFor] })
    .returning({ id: automationOccurrences.id });
  if (!occurrence) return null;

  const { taskId } = await insertTaskWithFirstRun(tx, {
    agentId: agent.id,
    title: `${automation.name} — ${when}`,
    instructions: automation.instructions,
    automationId: automation.id,
    autoRetries: limits.taskAutoRetries,
    createdMessage:
      trigger === "manual"
        ? `You ran the automation “${automation.name}” now. It created this task for ${agent.name}.`
        : `The automation “${automation.name}” created this task for ${agent.name}, for its run at ${when} (${automation.timeZone}).`,
    createdData: { automationId: automation.id, occurrenceId: occurrence.id },
  });
  await tx.update(automationOccurrences).set({ taskId }).where(eq(automationOccurrences.id, occurrence.id));
  await tx.update(automations).set({ lastRunAt: scheduledFor }).where(eq(automations.id, automation.id));
  return { occurrenceId: occurrence.id, taskId };
}

/** Records a run a safeguard stopped. Idempotent, like startOccurrence. */
export async function recordSkipped(
  tx: Queryable,
  automation: AutomationRow,
  scheduledFor: Date,
  trigger: "schedule" | "manual",
  check: Extract<StartCheck, { ok: false }>,
): Promise<boolean> {
  const rows = await tx
    .insert(automationOccurrences)
    .values({ automationId: automation.id, scheduledFor, trigger, status: "skipped", reason: check.reason, message: check.message })
    .onConflictDoNothing({ target: [automationOccurrences.automationId, automationOccurrences.scheduledFor] })
    .returning({ id: automationOccurrences.id });
  return rows.length > 0;
}
