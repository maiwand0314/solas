import "server-only";
import { and, count, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { AUTOMATION_LIMITS, type AutomationLimitValues } from "@/lib/automations/limits";
import { describeSchedule, maxRunsPerDay, nextRunAfter, upcomingRuns, type Schedule } from "@/lib/automations/schedule";
import { automationSchema, type AutomationValues } from "@/lib/automations/validation";
import { ACTIVE_TASK_STATUSES } from "@/lib/tasks/status";
import { getDatabase, type Database } from "@/server/db/client";
import {
  agents,
  automationOccurrences,
  automations,
  tasks,
  type AgentRow,
  type AutomationOccurrenceRow,
  type AutomationRow,
  type TaskRow,
} from "@/server/db/schema";
import { getAgentReadiness, providerRegistry, type ProviderRegistry } from "@/server/providers/registry";
import type { Queryable } from "@/server/tasks/lifecycle";
import { AutomationServiceError, fromDatabaseError, validationError } from "./errors";
import { checkCanStart, startOccurrence, type AutomationLimits } from "./start";

// Automations from the web app's side (M6A): create, edit, pause and resume,
// delete, Run now, and read them with their history. Saving one only stores
// the schedule and its next run time; the worker's scheduler starts the runs.

/**
 * How an automation stands, as the owner sees it. "finished": a one-time
 * run that has happened. "missed": a one-time run the worker wasn't there
 * for, which needs the owner (Run now, or a new time).
 */
export type AutomationState = "active" | "paused" | "finished" | "missed";

export type OccurrenceView = Pick<
  AutomationOccurrenceRow,
  "id" | "scheduledFor" | "trigger" | "status" | "reason" | "missedCount" | "message" | "createdAt"
> & {
  task: Pick<TaskRow, "id" | "title" | "status" | "errorMessage" | "finishedAt" | "cancelRequestedAt"> | null;
};

export type AutomationSummary = Pick<
  AutomationRow,
  "id" | "name" | "description" | "enabled" | "schedule" | "timeZone" | "nextRunAt" | "lastRunAt" | "createdAt" | "updatedAt"
> & {
  state: AutomationState;
  scheduleText: string;
  agent: { id: string; name: string };
  lastOccurrence: OccurrenceView | null;
};

export type AutomationDetail = {
  automation: AutomationRow;
  state: AutomationState;
  scheduleText: string;
  agent: { id: string; name: string; readiness: "ready" | "disabled" | "unconfigured" };
  /** The next few runs (only while active). */
  upcoming: Date[];
  /** Newest first. */
  history: OccurrenceView[];
  /** The newest completed run's result. */
  latestResult: { taskId: string; title: string; result: string; finishedAt: Date | null } | null;
  /** A run is queued or running now (Run now would be refused). */
  hasActiveRun: boolean;
  counts: { started: number; missed: number; skipped: number };
};

const idSchema = z.uuid({ error: "Invalid automation." });
const HISTORY_SHOWN = 50;
const UPCOMING_SHOWN = 5;
/** Saves that change how many automations are scheduled take this lock, so two at once can't exceed the caps. */
const SAVE_LOCK = 6_001_002;

type Dependencies = {
  db: Database;
  providers: ProviderRegistry;
  limits?: AutomationLimits & Pick<AutomationLimitValues, "maxActiveAutomations">;
  /** The current time; tests pass their own. */
  clock?: () => Date;
};

export function createAutomationService({
  db,
  providers,
  limits = AUTOMATION_LIMITS,
  clock = () => new Date(),
}: Dependencies) {
  async function list(): Promise<AutomationSummary[]> {
    const rows = await query(() =>
      db
        .select({ automation: automations, agentName: agents.name })
        .from(automations)
        .innerJoin(agents, eq(agents.id, automations.agentId))
        .orderBy(sql`${automations.nextRunAt} asc nulls last`, sql`lower(${automations.name})`),
    );
    const latest = await latestOccurrences(rows.map((row) => row.automation.id));
    return rows.map(({ automation, agentName }) => {
      const lastOccurrence = latest.get(automation.id) ?? null;
      return {
        id: automation.id,
        name: automation.name,
        description: automation.description,
        enabled: automation.enabled,
        schedule: automation.schedule,
        timeZone: automation.timeZone,
        nextRunAt: automation.nextRunAt,
        lastRunAt: automation.lastRunAt,
        createdAt: automation.createdAt,
        updatedAt: automation.updatedAt,
        state: stateOf(automation, lastOccurrence),
        scheduleText: describeSchedule(automation.schedule),
        agent: { id: automation.agentId, name: agentName },
        lastOccurrence,
      };
    });
  }

  /** The newest occurrence of each automation, in one query. */
  async function latestOccurrences(ids: string[]): Promise<Map<string, OccurrenceView>> {
    if (ids.length === 0) return new Map();
    const rows = await query(() =>
      db
        .selectDistinctOn([automationOccurrences.automationId], {
          automationId: automationOccurrences.automationId,
          ...occurrenceColumns,
        })
        .from(automationOccurrences)
        .leftJoin(tasks, eq(tasks.id, automationOccurrences.taskId))
        .where(inArray(automationOccurrences.automationId, ids))
        .orderBy(automationOccurrences.automationId, desc(automationOccurrences.createdAt)),
    );
    return new Map(rows.map(({ automationId, ...row }) => [automationId, toOccurrenceView(row)]));
  }

  async function get(id: unknown): Promise<AutomationDetail> {
    const automation = await getRow(parse(idSchema, id));
    const [agentRows, historyRows, resultRows, [{ active }], countRows] = await Promise.all([
      query(() => db.select().from(agents).where(eq(agents.id, automation.agentId))),
      query(() =>
        db
          .select(occurrenceColumns)
          .from(automationOccurrences)
          .leftJoin(tasks, eq(tasks.id, automationOccurrences.taskId))
          .where(eq(automationOccurrences.automationId, automation.id))
          .orderBy(desc(automationOccurrences.createdAt))
          .limit(HISTORY_SHOWN),
      ),
      query(() =>
        db
          .select({ taskId: tasks.id, title: tasks.title, result: tasks.result, finishedAt: tasks.finishedAt })
          .from(tasks)
          .where(and(eq(tasks.automationId, automation.id), eq(tasks.status, "completed")))
          .orderBy(desc(tasks.finishedAt))
          .limit(1),
      ),
      query(() =>
        db
          .select({ active: count() })
          .from(tasks)
          .where(and(eq(tasks.automationId, automation.id), inArray(tasks.status, [...ACTIVE_TASK_STATUSES]))),
      ),
      query(() =>
        db
          .select({ status: automationOccurrences.status, runs: sql<number>`sum(greatest(${automationOccurrences.missedCount}, 1))::int` })
          .from(automationOccurrences)
          .where(eq(automationOccurrences.automationId, automation.id))
          .groupBy(automationOccurrences.status),
      ),
    ]);
    const agent = agentRows[0];
    const history = historyRows.map(toOccurrenceView);
    const latest = resultRows[0];
    const countOf = (status: string) => countRows.find((row) => row.status === status)?.runs ?? 0;
    return {
      automation,
      state: stateOf(automation, history[0] ?? null),
      scheduleText: describeSchedule(automation.schedule),
      agent: { id: agent.id, name: agent.name, readiness: getAgentReadiness(agent, providers).state },
      upcoming: automation.nextRunAt
        ? [
            automation.nextRunAt,
            ...upcomingRuns(automation.schedule, automation.timeZone, automation.nextRunAt, automation.scheduleAnchorAt, UPCOMING_SHOWN - 1),
          ]
        : [],
      history,
      latestResult: latest?.result ? { ...latest, result: latest.result } : null,
      hasActiveRun: active > 0,
      counts: { started: countOf("started"), missed: countOf("missed"), skipped: countOf("skipped") },
    };
  }

  async function create(input: unknown): Promise<AutomationRow> {
    const values = parse(automationSchema, input);
    const agent = await getAgent(values.agentId);
    const now = clock();
    return query(() =>
      db.transaction(async (tx) => {
        const nextRunAt = values.enabled ? firstRun(values.schedule, values.timeZone, now) : null;
        if (nextRunAt) await assertCanSchedule(tx, { agent, schedule: values.schedule });
        const [created] = await tx
          .insert(automations)
          .values({ ...values, scheduleAnchorAt: now, nextRunAt })
          .returning();
        return created;
      }),
    );
  }

  /**
   * Saves the whole automation. A new schedule or time zone (or turning it
   * on) recalculates the next run from now; otherwise the next run stays.
   */
  async function update(id: unknown, input: unknown): Promise<AutomationRow> {
    const automationId = parse(idSchema, id);
    const values = parse(automationSchema, input);
    const agent = await getAgent(values.agentId);
    const now = clock();
    return query(() =>
      db.transaction(async (tx) => {
        const current = await getRow(automationId, tx, true);
        const scheduleChanged =
          JSON.stringify(current.schedule) !== JSON.stringify(values.schedule) || current.timeZone !== values.timeZone;
        const turnedOn = values.enabled && !current.enabled;
        let nextRunAt: Date | null = null;
        let scheduleAnchorAt = current.scheduleAnchorAt;
        if (values.enabled) {
          if (scheduleChanged || turnedOn) {
            nextRunAt = firstRun(values.schedule, values.timeZone, now);
            scheduleAnchorAt = now;
          } else {
            // Unchanged schedule: keep the planned run (or none, for a finished one-time run).
            nextRunAt = current.nextRunAt;
          }
        }
        if (nextRunAt) await assertCanSchedule(tx, { agent, schedule: values.schedule, except: automationId });
        const [updated] = await tx
          .update(automations)
          .set({ ...values, scheduleAnchorAt, nextRunAt })
          .where(eq(automations.id, automationId))
          .returning();
        return updated;
      }),
    );
  }

  /** Pause (nothing is scheduled) or resume (the next run is counted from now; nothing missed is caught up). */
  async function setEnabled(id: unknown, enabled: boolean): Promise<AutomationRow> {
    const automationId = parse(idSchema, id);
    const now = clock();
    return query(() =>
      db.transaction(async (tx) => {
        const current = await getRow(automationId, tx, true);
        if (current.enabled === enabled) return current;
        if (!enabled) {
          const [paused] = await tx
            .update(automations)
            .set({ enabled: false, nextRunAt: null })
            .where(eq(automations.id, automationId))
            .returning();
          return paused;
        }
        const nextRunAt = nextRunAfter(current.schedule, current.timeZone, now, now);
        if (!nextRunAt) {
          throw new AutomationServiceError(
            "validation_failed",
            "This one-time run’s time has passed. Edit the automation to choose a new time.",
          );
        }
        const [agent] = await tx.select().from(agents).where(eq(agents.id, current.agentId));
        await assertCanSchedule(tx, { agent, schedule: current.schedule, except: automationId });
        const [resumed] = await tx
          .update(automations)
          .set({ enabled: true, nextRunAt, scheduleAnchorAt: now })
          .where(eq(automations.id, automationId))
          .returning();
        return resumed;
      }),
    );
  }

  /** Deletes the automation and its run history. The tasks it created stay, without the link. */
  async function remove(id: unknown): Promise<void> {
    const automationId = parse(idSchema, id);
    const deleted = await query(() =>
      db.delete(automations).where(eq(automations.id, automationId)).returning({ id: automations.id }),
    );
    if (deleted.length === 0) throw notFound();
  }

  /**
   * Starts one run now, as the owner's explicit choice (also how a missed
   * one-time run is run). The same safeguards as a scheduled run apply; the
   * schedule itself doesn't change.
   */
  async function runNow(id: unknown): Promise<{ taskId: string }> {
    const automationId = parse(idSchema, id);
    const now = clock();
    return query(() =>
      db.transaction(async (tx) => {
        const automation = await getRow(automationId, tx, true);
        const [agent] = await tx.select().from(agents).where(eq(agents.id, automation.agentId));
        const check = await checkCanStart(tx, { automation, agent, now, providers, limits });
        if (!check.ok) throw new AutomationServiceError("cannot_start", check.message.replace(/^Skipped: /, "Can’t run now: "));
        const started = await startOccurrence(tx, { automation, agent, scheduledFor: now, trigger: "manual", limits });
        if (!started) throw new AutomationServiceError("cannot_start", "This run was just started. Check the history.");
        return { taskId: started.taskId };
      }),
    );
  }

  /** The first run of a schedule set now. A one-time run in the past is refused. */
  function firstRun(schedule: Schedule, timeZone: string, now: Date): Date {
    const next = nextRunAfter(schedule, timeZone, now, now);
    if (!next) {
      const message = "This time has already passed. Choose a time in the future.";
      throw new AutomationServiceError("validation_failed", message, { schedule: [message] });
    }
    return next;
  }

  /**
   * Checks that scheduling this automation stays within the safeguards: its
   * agent can work, at most maxActiveAutomations are scheduled, and their
   * worst-case runs per day stay under maxRunsPerDay.
   */
  async function assertCanSchedule(tx: Queryable, { agent, schedule, except }: { agent: AgentRow; schedule: Schedule; except?: string }) {
    const readiness = getAgentReadiness(agent, providers);
    if (readiness.state !== "ready") {
      const message =
        readiness.state === "disabled"
          ? `“${agent.name}” is disabled. Enable it, or save this automation as paused.`
          : `“${agent.name}” can’t work yet: ${readiness.reason} Choose a model for it first.`;
      throw new AutomationServiceError("agent_unavailable", message, { agentId: [message] });
    }
    await tx.execute(sql`select pg_advisory_xact_lock(${SAVE_LOCK})`);
    const others = await tx
      .select({ schedule: automations.schedule })
      .from(automations)
      .where(and(eq(automations.enabled, true), isNotNull(automations.nextRunAt), except ? ne(automations.id, except) : undefined));
    if (others.length >= limits.maxActiveAutomations) {
      throw new AutomationServiceError(
        "limit_reached",
        `At most ${limits.maxActiveAutomations} automations can be active at once. Pause one first, or save this one as paused.`,
      );
    }
    const planned = others.reduce((sum, row) => sum + maxRunsPerDay(row.schedule), 0) + maxRunsPerDay(schedule);
    if (planned > limits.maxRunsPerDay) {
      const message =
        `Together, your active automations could run ${planned} times a day; the limit is ${limits.maxRunsPerDay}. ` +
        "Choose a longer interval, or pause another automation.";
      throw new AutomationServiceError("limit_reached", message, { schedule: [message] });
    }
  }

  async function getRow(id: string, from: Queryable = db, lock = false): Promise<AutomationRow> {
    const select = from.select().from(automations).where(eq(automations.id, id)).limit(1);
    const [row] = await query(() => (lock ? select.for("update") : select));
    if (!row) throw notFound();
    return row;
  }

  async function getAgent(id: string): Promise<AgentRow> {
    const [agent] = await query(() => db.select().from(agents).where(eq(agents.id, id)).limit(1));
    if (!agent) {
      const message = "This agent doesn’t exist. It may have been deleted.";
      throw new AutomationServiceError("agent_not_found", message, { agentId: [message] });
    }
    return agent;
  }

  return { list, get, create, update, setEnabled, remove, runNow };
}

export type AutomationService = ReturnType<typeof createAutomationService>;

export function getAutomationService(): AutomationService {
  return createAutomationService({ db: getDatabase(), providers: providerRegistry });
}

const occurrenceColumns = {
  id: automationOccurrences.id,
  scheduledFor: automationOccurrences.scheduledFor,
  trigger: automationOccurrences.trigger,
  status: automationOccurrences.status,
  reason: automationOccurrences.reason,
  missedCount: automationOccurrences.missedCount,
  message: automationOccurrences.message,
  createdAt: automationOccurrences.createdAt,
  taskId: tasks.id,
  taskTitle: tasks.title,
  taskStatus: tasks.status,
  taskErrorMessage: tasks.errorMessage,
  taskFinishedAt: tasks.finishedAt,
  taskCancelRequestedAt: tasks.cancelRequestedAt,
};

/** An occurrence joined with its task (all task columns null when there is none). */
type OccurrenceRow = Omit<OccurrenceView, "task"> & {
  taskId: string | null;
  taskTitle: string | null;
  taskStatus: TaskRow["status"] | null;
  taskErrorMessage: string | null;
  taskFinishedAt: Date | null;
  taskCancelRequestedAt: Date | null;
};

function toOccurrenceView(row: OccurrenceRow): OccurrenceView {
  const { taskId, taskTitle, taskStatus, taskErrorMessage, taskFinishedAt, taskCancelRequestedAt, ...occurrence } = row;
  return {
    ...occurrence,
    task:
      taskId && taskTitle && taskStatus
        ? {
            id: taskId,
            title: taskTitle,
            status: taskStatus,
            errorMessage: taskErrorMessage,
            finishedAt: taskFinishedAt,
            cancelRequestedAt: taskCancelRequestedAt,
          }
        : null,
  };
}

function stateOf(automation: AutomationRow, last: Pick<OccurrenceView, "status"> | null): AutomationState {
  if (!automation.enabled) return "paused";
  if (automation.nextRunAt) return "active";
  return last?.status === "missed" ? "missed" : "finished";
}

function notFound() {
  return new AutomationServiceError("not_found", "This automation doesn’t exist. It may have been deleted.");
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

async function query<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AutomationServiceError) throw error;
    throw fromDatabaseError(error);
  }
}

export type { AutomationValues };
