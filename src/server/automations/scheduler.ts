import "server-only";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { AUTOMATION_LIMITS } from "@/lib/automations/limits";
import { formatInTimeZone, planDueRuns, type DuePlan } from "@/lib/automations/schedule";
import type { Database } from "@/server/db/client";
import { agents, automationOccurrences, automations, type AutomationRow } from "@/server/db/schema";
import type { Logger } from "@/server/logger";
import type { ProviderRegistry } from "@/server/providers/registry";
import type { Queryable } from "@/server/tasks/lifecycle";
import { checkCanStart, recordSkipped, startOccurrence, type AutomationLimits } from "./start";

// The scheduler (M6A) runs inside the worker. Every few seconds it asks
// PostgreSQL which active automations are due (next_run_at has come) and, for
// each, in one transaction:
//
//   1. locks the automation row (FOR UPDATE SKIP LOCKED: a second worker
//      skips it instead of waiting, so only one handles it);
//   2. works out which runs are due (planDueRuns): only the latest may start,
//      and only if it's at most a few minutes late; older ones are missed;
//   3. records the missed runs, then starts the run (or records why a
//      safeguard skipped it) — the run's identity is (automation, time), and
//      a unique index makes a second record of it impossible;
//   4. moves next_run_at to the next run after now.
//
// A started run is an ordinary task in the existing queue; the worker's run
// loop executes it like any other. The scheduler itself never calls Claude.

/** Automations handled per check; the rest wait for the next check (seconds later). */
const BATCH = 20;

export type TickResult = { started: number; skipped: number; missed: number };

type Dependencies = {
  db: Database;
  providers: ProviderRegistry;
  log: Logger;
  limits?: AutomationLimits;
  /** The current time. Defaults to the database clock; tests pass a controlled clock. */
  clock?: () => Promise<Date> | Date;
};

export function createScheduler({ db, providers, log, limits = AUTOMATION_LIMITS, clock }: Dependencies) {
  async function now(): Promise<Date> {
    if (clock) return clock();
    // The database clock, like every other time comparison the worker makes.
    const [row] = await db.execute<{ now: string | Date }>(sql`select now() as now`);
    return new Date(row.now);
  }

  /** One check: handles every automation that is due by now. */
  async function tick(): Promise<TickResult> {
    const at = await now();
    const due = await db
      .select({ id: automations.id })
      .from(automations)
      .where(and(eq(automations.enabled, true), lte(automations.nextRunAt, at)))
      .orderBy(asc(automations.nextRunAt))
      .limit(BATCH);
    const total: TickResult = { started: 0, skipped: 0, missed: 0 };
    for (const { id } of due) {
      const result = await handleDue(id, at);
      total.started += result.started;
      total.skipped += result.skipped;
      total.missed += result.missed;
    }
    return total;
  }

  async function handleDue(id: string, at: Date): Promise<TickResult> {
    const result: TickResult = { started: 0, skipped: 0, missed: 0 };
    await db.transaction(async (tx) => {
      // Checked again under the lock: it may have been paused, edited, or
      // handled by another worker since the select above.
      const [automation] = await tx
        .select()
        .from(automations)
        .where(and(eq(automations.id, id), eq(automations.enabled, true), lte(automations.nextRunAt, at)))
        .for("update", { skipLocked: true });
      if (!automation) return;

      const plan = planDueRuns(
        automation.schedule,
        automation.timeZone,
        automation.scheduleAnchorAt,
        automation.nextRunAt!,
        at,
        limits.missedAfterMs,
      );
      if (plan.missed && (await recordMissed(tx, automation, plan.missed))) result.missed += plan.missed.count;

      if (plan.run) {
        const [agent] = await tx.select().from(agents).where(eq(agents.id, automation.agentId));
        const check = await checkCanStart(tx, { automation, agent, now: at, providers, limits });
        if (check.ok) {
          const started = await startOccurrence(tx, { automation, agent, scheduledFor: plan.run, trigger: "schedule", limits });
          if (started) {
            result.started++;
            log("info", "automation.started", { automationId: automation.id, taskId: started.taskId });
          }
        } else if (await recordSkipped(tx, automation, plan.run, "schedule", check)) {
          result.skipped++;
          log("warn", "automation.skipped", { automationId: automation.id, reason: check.reason });
        }
      }

      await tx.update(automations).set({ nextRunAt: plan.next }).where(eq(automations.id, automation.id));
    });
    return result;
  }

  /**
   * One row for a whole period of downtime, not one per run, so a long
   * outage of an hourly automation doesn't flood its history.
   */
  async function recordMissed(tx: Queryable, automation: AutomationRow, missed: NonNullable<DuePlan["missed"]>) {
    const zone = automation.timeZone;
    const first = formatInTimeZone(missed.first, zone);
    const message =
      automation.schedule.kind === "once"
        ? `Missed: the worker wasn’t running at ${first}. A one-time run doesn’t start late by itself; use Run now or choose a new time.`
        : missed.count === 1
          ? `Missed the run at ${first}: the worker wasn’t running. It was skipped, not caught up later.`
          : `Missed ${missed.countIsLowerBound ? "more than " : ""}${missed.count} runs from ${first} to ` +
            `${formatInTimeZone(missed.last, zone)}: the worker wasn’t running. They were skipped, not caught up later.`;
    const rows = await tx
      .insert(automationOccurrences)
      .values({
        automationId: automation.id,
        scheduledFor: missed.first,
        status: "missed",
        missedCount: missed.count,
        message,
      })
      .onConflictDoNothing({ target: [automationOccurrences.automationId, automationOccurrences.scheduledFor] })
      .returning({ id: automationOccurrences.id });
    if (rows.length > 0) log("warn", "automation.missed", { automationId: automation.id, count: missed.count });
    return rows.length > 0;
  }

  return { tick };
}

export type Scheduler = ReturnType<typeof createScheduler>;
