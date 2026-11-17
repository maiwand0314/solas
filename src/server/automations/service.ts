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
  teamMembers,
  teams,
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
  "id" | "name" | "description" | "enabled" | "schedule" | "timeZone" | "nextRunAt" | "lastRunAt" | "createdAt" | "updatedAt" | "pausedReason"
> & {
  state: AutomationState;
  scheduleText: string;
  /** An individual automation's agent; null for a team automation. */
  agent: { id: string; name: string } | null;
  /** A team automation's team and its current coordinator (null: none, so runs are skipped). */
  team: { id: string; name: string; coordinator: { id: string; name: string } | null } | null;
  lastOccurrence: OccurrenceView | null;
};

export type AutomationDetail = {
  automation: AutomationRow;
  state: AutomationState;
  scheduleText: string;
  agent: { id: string; name: string; readiness: "ready" | "disabled" | "unconfigured" } | null;
  team: {
    id: string;
    name: string;
    coordinator: { id: string; name: string; readiness: "ready" | "disabled" | "unconfigured" } | null;
  } | null;
  /** The next few runs (only while active). */
  upcoming: Date[];
  /** Newest scheduled time first. */
  history: OccurrenceView[];
  /** The newest completed run's result. */
  latestResult: { taskId: string; title: string; result: string; finishedAt: Date | null } | null;
  /** A run is queued or running now (Run now would be refused). */
  hasActiveRun: boolean;
  counts: { started: number; missed: number; skipped: number };
};

type Executor = { agent: AgentRow; field: "agentId" | "teamId" };

/** The form's values as columns: the duration is stored in milliseconds. */
function toColumns(values: AutomationValues) {
  const { maxDurationMinutes, ...rest } = values;
  // targetKind only chose which of agentId / teamId is kept; it isn't a column.
  return { ...rest, targetKind: undefined, maxDurationMs: maxDurationMinutes ? maxDurationMinutes * 60_000 : null };
}

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
        .select({ automation: automations, agentName: agents.name, teamName: teams.name })
        .from(automations)
        .leftJoin(agents, eq(agents.id, automations.agentId))
        .leftJoin(teams, eq(teams.id, automations.teamId))
        .orderBy(sql`${automations.nextRunAt} asc nulls last`, sql`lower(${automations.name})`),
    );
    const latest = await latestOccurrences(rows.map((row) => row.automation.id));
    const coordinators = await coordinatorsOf(rows.flatMap((row) => (row.automation.teamId ? [row.automation.teamId] : [])));
    return rows.map(({ automation, agentName, teamName }) => {
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
        pausedReason: automation.pausedReason,
        state: stateOf(automation, lastOccurrence),
        scheduleText: describeSchedule(automation.schedule),
        agent: automation.agentId && agentName ? { id: automation.agentId, name: agentName } : null,
        team:
          automation.teamId && teamName
            ? {
                id: automation.teamId,
                name: teamName,
                coordinator: pickCoordinator(coordinators.get(automation.teamId)),
              }
            : null,
        lastOccurrence,
      };
    });
  }

  /** The current coordinator (an agent row) of each team, in one query. */
  async function coordinatorsOf(teamIds: string[]): Promise<Map<string, AgentRow>> {
    if (teamIds.length === 0) return new Map();
    const rows = await query(() =>
      db
        .select({ teamId: teamMembers.teamId, agent: agents })
        .from(teamMembers)
        .innerJoin(agents, eq(agents.id, teamMembers.agentId))
        .where(and(inArray(teamMembers.teamId, teamIds), eq(teamMembers.role, "coordinator"))),
    );
    return new Map(rows.map((row) => [row.teamId, row.agent]));
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
        .orderBy(automationOccurrences.automationId, desc(automationOccurrences.scheduledFor)),
    );
    return new Map(rows.map(({ automationId, ...row }) => [automationId, toOccurrenceView(row)]));
  }

  async function get(id: unknown): Promise<AutomationDetail> {
    const automation = await getRow(parse(idSchema, id));
    const [agentRows, historyRows, resultRows, [{ active }], countRows, teamRows] = await Promise.all([
      automation.agentId
        ? query(() => db.select().from(agents).where(eq(agents.id, automation.agentId!)))
        : Promise.resolve([] as AgentRow[]),
      query(() =>
        db
          .select(occurrenceColumns)
          .from(automationOccurrences)
          .leftJoin(tasks, eq(tasks.id, automationOccurrences.taskId))
          .where(eq(automationOccurrences.automationId, automation.id))
          // By when each run was due: a missed period is recorded later, but belongs where it happened.
          .orderBy(desc(automationOccurrences.scheduledFor))
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
      automation.teamId
        ? query(() => db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.id, automation.teamId!)))
        : Promise.resolve([] as { id: string; name: string }[]),
    ]);
    const agent = agentRows[0];
    const team = teamRows[0];
    const coordinator = team ? (await coordinatorsOf([team.id])).get(team.id) : undefined;
    const history = historyRows.map(toOccurrenceView);
    const latest = resultRows[0];
    const countOf = (status: string) => countRows.find((row) => row.status === status)?.runs ?? 0;
    return {
      automation,
      state: stateOf(automation, history[0] ?? null),
      scheduleText: describeSchedule(automation.schedule),
      agent: agent ? { id: agent.id, name: agent.name, readiness: getAgentReadiness(agent, providers).state } : null,
      team: team
        ? {
            ...team,
            coordinator: coordinator
              ? { id: coordinator.id, name: coordinator.name, readiness: getAgentReadiness(coordinator, providers).state }
              : null,
          }
        : null,
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
    const executor = await getExecutor(values);
    const now = clock();
    return query(() =>
      db.transaction(async (tx) => {
        const nextRunAt = values.enabled ? firstRun(values.schedule, values.timeZone, now) : null;
        if (nextRunAt) await assertCanSchedule(tx, { executor, schedule: values.schedule });
        const [created] = await tx
          .insert(automations)
          .values({ ...toColumns(values), scheduleAnchorAt: now, nextRunAt })
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
    const executor = await getExecutor(values);
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
        if (nextRunAt) await assertCanSchedule(tx, { executor, schedule: values.schedule, except: automationId });
        const [updated] = await tx
          .update(automations)
          // Saving is the owner's deliberate edit: an automatic pause's reason no longer applies once it is on again.
          .set({ ...toColumns(values), scheduleAnchorAt, nextRunAt, pausedReason: values.enabled ? null : current.pausedReason })
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
            .set({ enabled: false, nextRunAt: null, pausedReason: null })
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
        const executor = await getExecutor(current);
        await assertCanSchedule(tx, { executor, schedule: current.schedule, except: automationId });
        const [resumed] = await tx
          .update(automations)
          .set({ enabled: true, nextRunAt, scheduleAnchorAt: now, pausedReason: null })
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
        const check = await checkCanStart(tx, { automation, now, providers, limits, trigger: "manual" });
        if (!check.ok) throw new AutomationServiceError("cannot_start", check.message.replace(/^(Skipped|Paused): /, "Can’t run now: "));
        const started = await startOccurrence(tx, { automation, check, scheduledFor: now, trigger: "manual", limits });
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
  async function assertCanSchedule(
    tx: Queryable,
    { executor, schedule, except }: { executor: Executor; schedule: Schedule; except?: string },
  ) {
    const { agent, field } = executor;
    const readiness = getAgentReadiness(agent, providers);
    if (readiness.state !== "ready") {
      const who = field === "teamId" ? `The coordinator “${agent.name}”` : `“${agent.name}”`;
      const message =
        readiness.state === "disabled"
          ? `${who} is disabled. Enable it, or save this automation as paused.`
          : `${who} can’t work yet: ${readiness.reason} Choose a model for it first.`;
      throw new AutomationServiceError("agent_unavailable", message, { [field]: [message] });
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

  /**
   * Who will do the work, checked when saving: the chosen agent, or the
   * chosen team's coordinator (the team must exist and have one).
   */
  async function getExecutor(values: { agentId: string | null; teamId: string | null }): Promise<Executor> {
    if (values.teamId) {
      const [team] = await query(() => db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.id, values.teamId!)));
      if (!team) {
        const message = "This team doesn’t exist. It may have been deleted.";
        throw new AutomationServiceError("agent_not_found", message, { teamId: [message] });
      }
      const coordinator = (await coordinatorsOf([team.id])).get(team.id);
      if (!coordinator) {
        const message = `The team “${team.name}” has no coordinator. Choose one on the team page first.`;
        throw new AutomationServiceError("agent_unavailable", message, { teamId: [message] });
      }
      return { agent: coordinator, field: "teamId" };
    }
    const [agent] = await query(() => db.select().from(agents).where(eq(agents.id, values.agentId!)).limit(1));
    if (!agent) {
      const message = "This agent doesn’t exist. It may have been deleted.";
      throw new AutomationServiceError("agent_not_found", message, { agentId: [message] });
    }
    return { agent, field: "agentId" };
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

function pickCoordinator(agent: AgentRow | undefined): { id: string; name: string } | null {
  return agent ? { id: agent.id, name: agent.name } : null;
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
