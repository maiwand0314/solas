import "server-only";
import { and, count, desc, eq, gt, inArray, isNotNull, not, sql } from "drizzle-orm";
import type { AutomationLimitValues } from "@/lib/automations/limits";
import { formatInTimeZone } from "@/lib/automations/schedule";
import { ACTIVE_TASK_STATUSES } from "@/lib/tasks/status";
import {
  automationOccurrences,
  automations,
  agents,
  runs,
  tasks,
  teamMembers,
  teams,
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
  "maxConcurrentExecutions" | "maxRunsPerDay" | "usageLimitCooldownMs" | "taskAutoRetries" | "missedAfterMs" | "maxDurationMs"
>;

/** ok: the agent that will work (an individual's agent, or a team's coordinator) and the team, if any. */
export type StartCheck =
  | { ok: true; agent: AgentRow; teamId: string | null; maxDurationMs: number | null }
  | { ok: false; reason: OccurrenceSkipReason; message: string };

/**
 * Starts are serialised across every process with one transaction-scoped
 * advisory lock, so two schedulers (or a scheduler and Run now) can't both
 * pass the "how many are running" checks at the same moment. Held until the
 * transaction ends; always taken after the automation's row lock.
 */
const START_LOCK = 6_001_001;

/**
 * Who works on a run: the automation's own agent, or for a team automation
 * the team's coordinator right now (looked up each run, so a changed or
 * removed coordinator is noticed, never assumed). Null with a message if
 * nobody can.
 */
async function resolveAgent(
  tx: Queryable,
  automation: AutomationRow,
): Promise<{ agent: AgentRow; teamId: string | null } | { reason: OccurrenceSkipReason; message: string }> {
  if (automation.teamId) {
    const [team] = await tx.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.id, automation.teamId));
    if (!team) return { reason: "team_unavailable", message: "Skipped: the team of this automation no longer exists." };
    const [coordinator] = await tx
      .select({ agent: agents })
      .from(teamMembers)
      .innerJoin(agents, eq(agents.id, teamMembers.agentId))
      .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.role, "coordinator")));
    if (!coordinator) {
      return { reason: "team_unavailable", message: `Skipped: the team “${team.name}” has no coordinator. Choose one on the team page.` };
    }
    return { agent: coordinator.agent, teamId: team.id };
  }
  const [agent] = automation.agentId ? await tx.select().from(agents).where(eq(agents.id, automation.agentId)) : [];
  if (!agent) return { reason: "agent_unavailable", message: "Skipped: the agent of this automation no longer exists." };
  return { agent, teamId: null };
}

/**
 * Whether a run may start now. In order: someone can work on it (agent or
 * the team's coordinator, enabled and with a model), the automation hasn't
 * failed too many times in a row (scheduled runs only), the previous run has
 * finished (unless this automation allows overlap), Claude hasn't reported a
 * usage limit recently, and the daily cap of this automation and the global
 * concurrent and daily caps aren't reached. Per-automation limits are never
 * looser than the global ones: the global checks always run. Takes the start lock.
 */
export async function checkCanStart(
  tx: Queryable,
  { automation, now, providers, limits, trigger = "schedule" }: {
    automation: AutomationRow;
    now: Date;
    providers: ProviderRegistry;
    limits: AutomationLimits;
    trigger?: "schedule" | "manual";
  },
): Promise<StartCheck> {
  await tx.execute(sql`select pg_advisory_xact_lock(${START_LOCK})`);

  const resolved = await resolveAgent(tx, automation);
  if ("reason" in resolved) return skip(resolved.reason, resolved.message);
  const { agent, teamId } = resolved;

  const readiness = getAgentReadiness(agent, providers);
  if (readiness.state !== "ready") {
    const why = readiness.state === "disabled" ? "is disabled" : "has no available model";
    const role = teamId ? "the coordinator" : "";
    return skip(
      "agent_unavailable",
      `Skipped: ${role ? `${role} ` : ""}“${agent.name}” ${why}. Enable it or choose a model to let this automation run.`,
    );
  }

  // The owner's explicit Run now is allowed after failures: it is how they try again.
  if (trigger === "schedule" && automation.pauseAfterFailures) {
    const streak = automation.pauseAfterFailures;
    const lastFinished = await tx
      .select({ status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.automationId, automation.id), not(inArray(tasks.status, [...ACTIVE_TASK_STATUSES]))))
      .orderBy(desc(tasks.createdAt))
      .limit(streak);
    if (lastFinished.length === streak && lastFinished.every((task) => task.status === "failed" || task.status === "interrupted")) {
      return skip(
        "paused_after_failures",
        `Paused: the last ${streak} ${streak === 1 ? "run" : "runs"} failed in a row. Check the task, then resume the automation.`,
      );
    }
  }

  const active = inArray(tasks.status, [...ACTIVE_TASK_STATUSES]);
  if (!automation.allowOverlap) {
    const [{ running }] = await tx
      .select({ running: count() })
      .from(tasks)
      .where(and(eq(tasks.automationId, automation.id), active));
    if (running > 0) {
      return skip("overlap", "Skipped: the previous run of this automation hadn’t finished, and this automation doesn’t allow overlapping runs.");
    }
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

  const dayStart = new Date(now.getTime() - 24 * 60 * 60_000);
  if (automation.maxRunsPerDay) {
    const cap = Math.min(automation.maxRunsPerDay, limits.maxRunsPerDay);
    const [{ own }] = await tx
      .select({ own: count() })
      .from(tasks)
      .where(and(eq(tasks.automationId, automation.id), gt(tasks.createdAt, dayStart)));
    if (own >= cap) {
      return skip("automation_daily_limit", `Skipped: this automation already started ${own} ${own === 1 ? "run" : "runs"} in the last 24 hours (its limit is ${cap}).`);
    }
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
  // Never longer than the global limit, even if a row was edited by hand.
  const maxDurationMs = automation.maxDurationMs ? Math.min(automation.maxDurationMs, limits.maxDurationMs) : null;
  return { ok: true, agent, teamId, maxDurationMs };
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
    check,
    scheduledFor,
    trigger,
    limits,
  }: {
    automation: AutomationRow;
    check: Extract<StartCheck, { ok: true }>;
    scheduledFor: Date;
    trigger: "schedule" | "manual";
    limits: AutomationLimits;
  },
): Promise<{ occurrenceId: string; taskId: string } | null> {
  const { agent, teamId, maxDurationMs } = check;
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
    // The team is fixed on the task now: later membership changes don't move it.
    teamId,
    maxDurationMs,
    autoRetries: limits.taskAutoRetries,
    createdMessage:
      trigger === "manual"
        ? `You ran the automation “${automation.name}” now. It created this task for ${agent.name}${teamId ? " (the team’s coordinator)" : ""}.`
        : `The automation “${automation.name}” created this task for ${agent.name}${teamId ? " (the team’s coordinator)" : ""}, for its run at ${when} (${automation.timeZone}).`,
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
