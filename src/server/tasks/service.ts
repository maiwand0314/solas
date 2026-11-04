import "server-only";
import { and, asc, count, desc, eq, ilike, inArray, max, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { TASK_FILTERS, type TaskFilterId } from "@/lib/tasks/status";
import { createTaskSchema } from "@/lib/tasks/validation";
import { getDatabase, type Database } from "@/server/db/client";
import {
  agents,
  runs,
  taskDelegations,
  taskEvents,
  tasks,
  teamMembers,
  teams,
  toolCalls,
  type AgentRow,
  type RunRow,
  type TaskEventRow,
  type TaskDelegationRow,
  type TaskRow,
  type TaskStatus,
  type ToolCallRow,
} from "@/server/db/schema";
import { getAgentReadiness, providerRegistry, type ProviderRegistry } from "@/server/providers/registry";
import { RUN_LIMITS } from "@/server/runs/config";
import { TaskServiceError, fromDatabaseError, validationError } from "./errors";
import { jsonLogger } from "@/server/logger";
import { cancelTaskInTx, stopOrphanedChildren } from "./cancel";
import { recordTaskEvent } from "./events";
import { transitionTask, type Queryable } from "./lifecycle";

// Tasks from the web app's side: create one (a task row plus its first run,
// which the worker picks up), list and read them, cancel, and retry. Nothing
// here talks to Claude; the worker does the work (src/server/tasks/execution.ts).

export type TaskSummary = Pick<
  TaskRow,
  "id" | "title" | "status" | "cancelRequestedAt" | "createdAt" | "updatedAt" | "finishedAt" | "parentTaskId"
> & {
  agentId: string;
  agentName: string;
  /** For a delegated task: the agent of the task that delegated it. */
  delegatedBy: string | null;
  /** The team the task was given to (M5B), if any. */
  team: { id: string; name: string } | null;
};

/** One attempt as the task page shows it: its state, never worker internals. */
export type TaskAttempt = Pick<
  RunRow,
  | "id"
  | "attempt"
  | "status"
  | "modelId"
  | "errorCode"
  | "errorMessage"
  | "partialOutput"
  | "cancelRequestedAt"
  | "inputTokens"
  | "outputTokens"
  | "notBefore"
  | "createdAt"
  | "startedAt"
  | "finishedAt"
>;

export type TaskEventView = Pick<TaskEventRow, "id" | "runId" | "type" | "message" | "createdAt">;

export type TaskToolCall = Pick<
  ToolCallRow,
  | "id"
  | "runId"
  | "toolId"
  | "input"
  | "inputSummary"
  | "status"
  | "requiresApproval"
  | "approvalExpiresAt"
  | "decidedAt"
  | "resultSummary"
  | "errorMessage"
  | "createdAt"
  | "finishedAt"
>;

/** A delegation as the parent task's page shows it (M5A). */
export type TaskDelegationView = {
  id: string;
  status: TaskDelegationRow["status"];
  taskDescription: string;
  expectedOutput: string | null;
  createdAt: Date;
  completedAt: Date | null;
  agent: { id: string; name: string };
  child: Pick<TaskRow, "id" | "title" | "status" | "cancelRequestedAt" | "result" | "errorMessage" | "finishedAt">;
  /** The child's tool calls waiting for the owner's approval, so they can be decided from the parent too. */
  waitingCalls: TaskToolCall[];
};

/** The task that delegated this one (M5A). */
export type TaskParentView = {
  task: Pick<TaskRow, "id" | "title" | "status">;
  agent: { id: string; name: string };
};

export type TaskDetail = {
  task: TaskRow;
  agent: Pick<AgentRow, "id" | "name" | "enabled" | "providerId" | "modelId">;
  attempts: TaskAttempt[];
  events: TaskEventView[];
  toolCalls: TaskToolCall[];
  parent: TaskParentView | null;
  delegations: TaskDelegationView[];
  /** The team the task was given to (M5B), if it still exists. */
  team: { id: string; name: string } | null;
};

export type TaskListQuery = { filter?: TaskFilterId; search?: string; teamId?: string };

const attemptColumns = {
  id: runs.id,
  attempt: runs.attempt,
  status: runs.status,
  modelId: runs.modelId,
  errorCode: runs.errorCode,
  errorMessage: runs.errorMessage,
  partialOutput: runs.partialOutput,
  cancelRequestedAt: runs.cancelRequestedAt,
  inputTokens: runs.inputTokens,
  outputTokens: runs.outputTokens,
  notBefore: runs.notBefore,
  createdAt: runs.createdAt,
  startedAt: runs.startedAt,
  finishedAt: runs.finishedAt,
};

const toolCallColumns = {
  id: toolCalls.id,
  runId: toolCalls.runId,
  toolId: toolCalls.toolId,
  input: toolCalls.input,
  inputSummary: toolCalls.inputSummary,
  status: toolCalls.status,
  requiresApproval: toolCalls.requiresApproval,
  approvalExpiresAt: toolCalls.approvalExpiresAt,
  decidedAt: toolCalls.decidedAt,
  resultSummary: toolCalls.resultSummary,
  errorMessage: toolCalls.errorMessage,
  createdAt: toolCalls.createdAt,
  finishedAt: toolCalls.finishedAt,
};

const idSchema = z.uuid({ error: "Invalid task." });
const parentTasks = alias(tasks, "parent_tasks");
const parentAgents = alias(agents, "parent_agents");
const searchSchema = z.string().trim().max(200).catch("");
/** One owner, a working list: the most recently active tasks are enough. */
const LIST_LIMIT = 200;
const RETRYABLE: readonly TaskStatus[] = ["failed", "interrupted", "cancelled"];

type Dependencies = {
  db: Database;
  providers: ProviderRegistry;
  limits?: { taskAutoRetries: number };
};

export function createTaskService({ db, providers, limits = RUN_LIMITS }: Dependencies) {
  /**
   * Creates a task and queues its first attempt, in one transaction. Checks
   * the agent first so the owner gets a clear error now, not a failed task
   * a second later. Safe to repeat with the same `clientRequestId`.
   */
  async function create(input: unknown): Promise<{ taskId: string }> {
    const { agentId, title, instructions, clientRequestId, teamId } = parse(createTaskSchema, input);
    if (clientRequestId) {
      const existing = await findCreated(clientRequestId);
      if (existing) return existing;
    }
    const agent = await getAgentRow(agentId);
    assertAgentCanRun(agent);
    if (teamId) await assertTeamMember(teamId, agentId);

    try {
      return await query(() =>
        db.transaction(async (tx) => {
          const [task] = await tx
            .insert(tasks)
            .values({ agentId, title, instructions, clientRequestId, teamId: teamId ?? null, autoRetriesLeft: limits.taskAutoRetries })
            .returning({ id: tasks.id });
          const [run] = await tx.insert(runs).values({ taskId: task.id, agentId, attempt: 1 }).returning({ id: runs.id });
          await recordTaskEvent(tx, { taskId: task.id, type: "created", message: `You created this task for ${agent.name}.` });
          await recordTaskEvent(tx, {
            taskId: task.id,
            runId: run.id,
            type: "queued",
            message: "Queued as attempt 1. It starts when the worker picks it up.",
            data: { attempt: 1 },
          });
          return { taskId: task.id };
        }),
      );
    } catch (error) {
      // Two identical submits at the same moment: the loser reports the winner's task.
      if (error instanceof TaskServiceError && error.code === "duplicate_request" && clientRequestId) {
        const winner = await findCreated(clientRequestId);
        if (winner) return winner;
      }
      throw error;
    }
  }

  async function findCreated(clientRequestId: string): Promise<{ taskId: string } | null> {
    const [task] = await query(() =>
      db.select({ taskId: tasks.id }).from(tasks).where(eq(tasks.clientRequestId, clientRequestId)).limit(1),
    );
    return task ?? null;
  }

  /** Tasks, most recently active first, optionally filtered by status group and text. */
  async function list({ filter = "all", search = "", teamId }: TaskListQuery = {}): Promise<TaskSummary[]> {
    const statuses = TASK_FILTERS.find((entry) => entry.id === filter)?.statuses ?? null;
    const conditions = [
      searchCondition(search),
      statuses ? inArray(tasks.status, [...statuses]) : undefined,
      teamCondition(teamId),
    ];
    return query(() =>
      db
        .select({
          id: tasks.id,
          title: tasks.title,
          status: tasks.status,
          cancelRequestedAt: tasks.cancelRequestedAt,
          createdAt: tasks.createdAt,
          updatedAt: tasks.updatedAt,
          finishedAt: tasks.finishedAt,
          parentTaskId: tasks.parentTaskId,
          agentId: agents.id,
          agentName: agents.name,
          delegatedBy: parentAgents.name,
          teamId: teams.id,
          teamName: teams.name,
        })
        .from(tasks)
        .innerJoin(agents, eq(agents.id, tasks.agentId))
        .leftJoin(parentTasks, eq(parentTasks.id, tasks.parentTaskId))
        .leftJoin(parentAgents, eq(parentAgents.id, parentTasks.agentId))
        .leftJoin(teams, eq(teams.id, tasks.teamId))
        .where(and(...conditions))
        .orderBy(desc(tasks.updatedAt))
        .limit(LIST_LIMIT),
    ).then((rows) =>
      rows.map(({ teamId: id, teamName, ...row }) => ({ ...row, team: id && teamName ? { id, name: teamName } : null })),
    );
  }

  /** Tasks given to one team (an explicit link, set when the task was created). */
  function teamCondition(teamId: string | undefined): SQL | undefined {
    return teamId && idSchema.safeParse(teamId).success ? eq(tasks.teamId, teamId) : undefined;
  }

  /** A task can be given to a team only through one of its members. */
  async function assertTeamMember(teamId: string, agentId: string) {
    const [member] = await query(() =>
      db
        .select({ agentId: teamMembers.agentId })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.agentId, agentId))),
    );
    if (!member) {
      const message = "This agent isn’t a member of the chosen team.";
      throw new TaskServiceError("validation_failed", message, { teamId: [message] });
    }
  }

  /** How many tasks each filter would show (for the same search), for the filter bar. */
  async function countByFilter(search = "", teamId?: string): Promise<Record<TaskFilterId, number>> {
    const rows = await query(() =>
      db
        .select({ status: tasks.status, count: count() })
        .from(tasks)
        .innerJoin(agents, eq(agents.id, tasks.agentId))
        .where(and(searchCondition(search), teamCondition(teamId)))
        .groupBy(tasks.status),
    );
    const byStatus = new Map(rows.map((row) => [row.status, row.count]));
    return Object.fromEntries(
      TASK_FILTERS.map((entry) => [
        entry.id,
        entry.statuses
          ? entry.statuses.reduce((sum, status) => sum + (byStatus.get(status) ?? 0), 0)
          : rows.reduce((sum, row) => sum + row.count, 0),
      ]),
    ) as Record<TaskFilterId, number>;
  }

  /** Text search over titles, instructions, and agent names. Wildcards in the input are matched literally. */
  function searchCondition(search: string): SQL | undefined {
    const text = searchSchema.parse(search);
    if (!text) return undefined;
    const pattern = `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
    return or(ilike(tasks.title, pattern), ilike(tasks.instructions, pattern), ilike(agents.name, pattern));
  }

  async function get(id: unknown): Promise<TaskDetail> {
    const task = await getTaskRow(parse(idSchema, id));
    const [agent, attempts, events, calls] = await Promise.all([
      getAgentRow(task.agentId),
      query(() => db.select(attemptColumns).from(runs).where(eq(runs.taskId, task.id)).orderBy(asc(runs.attempt))),
      query(() =>
        db
          .select({
            id: taskEvents.id,
            runId: taskEvents.runId,
            type: taskEvents.type,
            message: taskEvents.message,
            createdAt: taskEvents.createdAt,
          })
          .from(taskEvents)
          .where(eq(taskEvents.taskId, task.id))
          .orderBy(asc(taskEvents.id)),
      ),
      query(() =>
        db
          .select(toolCallColumns)
          .from(toolCalls)
          .innerJoin(runs, eq(runs.id, toolCalls.runId))
          .where(eq(runs.taskId, task.id))
          .orderBy(asc(toolCalls.createdAt)),
      ),
    ]);
    const [parent, delegations, team] = await Promise.all([parentOf(task), delegationsOf(task.id), teamOf(task)]);
    const { id: agentId, name, enabled, providerId, modelId } = agent;
    return {
      task,
      agent: { id: agentId, name, enabled, providerId, modelId },
      attempts,
      events,
      toolCalls: calls,
      parent,
      delegations,
      team,
    };
  }

  async function teamOf(task: TaskRow): Promise<{ id: string; name: string } | null> {
    if (!task.teamId) return null;
    const [team] = await query(() => db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.id, task.teamId!)));
    return team ?? null;
  }

  async function parentOf(task: TaskRow): Promise<TaskParentView | null> {
    if (!task.parentTaskId) return null;
    const [row] = await query(() =>
      db
        .select({ id: tasks.id, title: tasks.title, status: tasks.status, agentId: agents.id, agentName: agents.name })
        .from(tasks)
        .innerJoin(agents, eq(agents.id, tasks.agentId))
        .where(eq(tasks.id, task.parentTaskId!)),
    );
    return row
      ? { task: { id: row.id, title: row.title, status: row.status }, agent: { id: row.agentId, name: row.agentName } }
      : null;
  }

  async function delegationsOf(taskId: string): Promise<TaskDelegationView[]> {
    const rows = await query(() =>
      db
        .select({
          id: taskDelegations.id,
          status: taskDelegations.status,
          taskDescription: taskDelegations.taskDescription,
          expectedOutput: taskDelegations.expectedOutput,
          createdAt: taskDelegations.createdAt,
          completedAt: taskDelegations.completedAt,
          agentId: agents.id,
          agentName: agents.name,
          child: {
            id: tasks.id,
            title: tasks.title,
            status: tasks.status,
            cancelRequestedAt: tasks.cancelRequestedAt,
            result: tasks.result,
            errorMessage: tasks.errorMessage,
            finishedAt: tasks.finishedAt,
          },
        })
        .from(taskDelegations)
        .innerJoin(tasks, eq(tasks.id, taskDelegations.childTaskId))
        .innerJoin(agents, eq(agents.id, taskDelegations.targetAgentId))
        .where(eq(taskDelegations.parentTaskId, taskId))
        .orderBy(asc(taskDelegations.createdAt)),
    );
    return Promise.all(
      rows.map(async ({ agentId, agentName, ...row }) => ({
        ...row,
        agent: { id: agentId, name: agentName },
        waitingCalls: await query(() =>
          db
            .select(toolCallColumns)
            .from(toolCalls)
            .innerJoin(runs, eq(runs.id, toolCalls.runId))
            .where(and(eq(runs.taskId, row.child.id), eq(toolCalls.status, "awaiting_approval"))),
        ),
      })),
    );
  }

  /**
   * Cancels a task. A queued (or waiting, or interrupted) task is cancelled
   * at once. A running one gets a cancel request: the worker stops the
   * attempt within about a second and records "cancelled"; until then the
   * task truthfully stays running, marked as cancelling.
   *
   * Delegation (M5A): cancelling a parent cancels its delegated task too;
   * cancelling a delegated task lets its waiting parent continue without it.
   */
  async function cancel(id: unknown): Promise<TaskRow> {
    const taskId = parse(idSchema, id);
    const { task, childrenToStop } = await query(() => db.transaction((tx) => cancelTaskInTx(tx, taskId, "owner")));
    if (childrenToStop.length > 0) await stopOrphanedChildren(db, jsonLogger, taskId);
    return task;
  }

  /**
   * Starts a new attempt at a failed, interrupted, or cancelled task. The
   * owner's explicit choice, so it also resets the automatic retry. The
   * earlier attempts stay in the record.
   */
  async function retry(id: unknown): Promise<TaskRow> {
    const taskId = parse(idSchema, id);
    const task = await getTaskRow(taskId);
    if (task.parentTaskId) await assertParentWaitsFor(task);
    if (!RETRYABLE.includes(task.status)) {
      throw new TaskServiceError(
        "invalid_state",
        task.status === "completed"
          ? "This task is already completed."
          : "This task is still queued or running. Cancel it first, or wait for it to finish.",
      );
    }
    assertAgentCanRun(await getAgentRow(task.agentId));

    return query(() =>
      db.transaction(async (tx) => {
        const requeued = await transitionTask(
          tx,
          taskId,
          "queued",
          {
            autoRetriesLeft: limits.taskAutoRetries,
            result: null,
            errorCode: null,
            errorMessage: null,
            cancelRequestedAt: null,
            finishedAt: null,
          },
          RETRYABLE,
        );
        // Someone else (another tab) retried it a moment ago.
        if (!requeued) throw new TaskServiceError("invalid_state", "This task was already retried.");
        const [{ latest }] = await tx.select({ latest: max(runs.attempt) }).from(runs).where(eq(runs.taskId, taskId));
        const attempt = (latest ?? 0) + 1;
        const [run] = await tx
          .insert(runs)
          .values({ taskId, agentId: task.agentId, attempt })
          .returning({ id: runs.id });
        await recordTaskEvent(tx, {
          taskId,
          runId: run.id,
          type: "queued",
          message: `You retried this task. Queued as attempt ${attempt}.`,
          data: { attempt },
        });
        return getTaskRow(taskId, tx);
      }),
    );
  }

  /**
   * A delegated task can be retried only while its parent still waits for it
   * (it was interrupted). Once the parent has moved on with a failure or a
   * cancellation, a new result would reach no one: retry the parent instead.
   */
  async function assertParentWaitsFor(child: TaskRow) {
    const [delegation] = await query(() =>
      db
        .select({ status: taskDelegations.status, parentStatus: tasks.status })
        .from(taskDelegations)
        .innerJoin(tasks, eq(tasks.id, taskDelegations.parentTaskId))
        .where(eq(taskDelegations.childTaskId, child.id)),
    );
    if (delegation?.status !== "waiting" || delegation.parentStatus !== "waiting_on_delegate") {
      throw new TaskServiceError(
        "invalid_state",
        "The task that delegated this one has already moved on. Retry that task instead.",
      );
    }
  }

  async function getTaskRow(id: string, from: Queryable = db, lock = false): Promise<TaskRow> {
    const select = from.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    const [task] = await query(() => (lock ? select.for("update") : select));
    if (!task) throw new TaskServiceError("not_found", "This task doesn’t exist. It may have been deleted with its agent.");
    return task;
  }

  async function getAgentRow(id: string): Promise<AgentRow> {
    const [agent] = await query(() => db.select().from(agents).where(eq(agents.id, id)).limit(1));
    if (!agent) {
      throw new TaskServiceError("agent_not_found", "This agent doesn’t exist. It may have been deleted.", {
        agentId: ["This agent doesn’t exist. It may have been deleted."],
      });
    }
    return agent;
  }

  function assertAgentCanRun(agent: AgentRow) {
    const readiness = getAgentReadiness(agent, providers);
    if (readiness.state === "disabled") {
      throw new TaskServiceError("agent_unavailable", `“${agent.name}” is disabled. Enable it to give it tasks.`, {
        agentId: [`“${agent.name}” is disabled. Enable it to give it tasks.`],
      });
    }
    if (readiness.state === "unconfigured") {
      const message = `“${agent.name}” can’t work yet: ${readiness.reason} Edit the agent and choose a model.`;
      throw new TaskServiceError("agent_unavailable", message, { agentId: [message] });
    }
  }

  return { create, list, countByFilter, get, cancel, retry };
}

export type TaskService = ReturnType<typeof createTaskService>;

export function getTaskService(): TaskService {
  return createTaskService({ db: getDatabase(), providers: providerRegistry });
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
    if (error instanceof TaskServiceError) throw error;
    throw fromDatabaseError(error);
  }
}
