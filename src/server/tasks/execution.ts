import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { runs, tasks, toolCalls, type RunRow, type TaskEventData, type TaskEventType } from "@/server/db/schema";
import type { Logger } from "@/server/logger";
import type { ToolEvent } from "@/server/tools/invoker";
import { hasPendingDelegation, isDelegationCancelled, markChildrenCancelled, onChildFinished, onChildInterrupted, onParentRunCompleted } from "./delegation";
import { recordTaskEvent } from "./events";
import { decideAfterFailure, transitionTask, type AfterFailure, type Queryable } from "./lifecycle";

// The worker's side of tasks. The run executor calls these at each point of
// a task attempt (claimed, started, tool steps, ended), so a task's status
// and its timeline change together with the run, in the same transaction.
// Conversations never reach this file.

export type AttemptOutcome =
  | { status: "completed"; text: string }
  | { status: "failed"; code: string; message: string }
  | { status: "cancelled" };

export type TaskRunLimits = {
  /** Base wait before an automatic retry; doubles per attempt. */
  retryBackoffMs: number;
};

type Dependencies = {
  log: Logger;
  limits: TaskRunLimits;
  /**
   * True only for tools known to change nothing. Anything else (including a
   * tool that no longer exists) counts as having side effects, so an unknown
   * call never makes a retry look safe.
   */
  isReadOnlyTool: (toolId: string) => boolean;
};

/** Tool call statuses after which a tool may have done its work, or started to. */
const MAY_HAVE_RUN = new Set(["approved", "running", "succeeded", "failed"]);

export function createTaskRunHandlers({ log, limits, isReadOnlyTool }: Dependencies) {
  async function recordEvent(
    db: Queryable,
    taskId: string,
    runId: string | null,
    type: TaskEventType,
    message: string,
    data: TaskEventData = {},
  ) {
    await recordTaskEvent(db, { taskId, runId, type, message, data });
  }

  /**
   * Called inside the claim's transaction. Moves the task to running, or
   * returns false if it can't (e.g. it was cancelled in the same instant):
   * then the run must not execute.
   */
  async function onClaimed(tx: Queryable, run: RunRow): Promise<boolean> {
    const taskId = run.taskId!;
    // A child whose parent already stopped must not start.
    if (await isDelegationCancelled(tx, taskId)) return false;
    const moved = await transitionTask(tx, taskId, "running", { startedAt: sql`coalesce(${tasks.startedAt}, now())` }, [
      "queued",
    ]);
    if (!moved) return false;
    await recordEvent(tx, taskId, run.id, "claimed", `The worker picked up attempt ${run.attempt}.`, {
      attempt: run.attempt,
    });
    return true;
  }

  async function loadTask(db: Queryable, taskId: string) {
    const [task] = await db
      .select({ title: tasks.title, instructions: tasks.instructions, depth: tasks.depth })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    return task;
  }

  async function onStarted(db: Queryable, run: RunRow, info: { agentName: string; model: string; toolCount: number }) {
    const tools =
      info.toolCount === 0 ? "without tools" : `with ${info.toolCount} ${info.toolCount === 1 ? "tool" : "tools"}`;
    await recordEvent(db, run.taskId!, run.id, "started", `${info.agentName} started working (${info.model}, ${tools}).`, {
      attempt: run.attempt,
    });
  }

  /**
   * One step of a tool call. Approval steps also move the task between
   * running and awaiting_approval, so the Tasks page shows the wait.
   */
  async function onToolEvent(db: Queryable, run: RunRow, event: ToolEvent) {
    const taskId = run.taskId!;
    const data = { toolId: event.toolId, toolCallId: event.toolCallId, attempt: run.attempt };
    await db.transaction(async (tx) => {
      await recordEvent(tx, taskId, run.id, event.type, toolEventMessage(event), data);
      if (event.type === "approval_requested") {
        await transitionTask(tx, taskId, "awaiting_approval", {}, ["running"]);
      } else if (event.type.startsWith("approval_")) {
        // Back to running once nothing else in this attempt waits for the owner.
        const [stillWaiting] = await tx
          .select({ id: toolCalls.id })
          .from(toolCalls)
          .where(and(eq(toolCalls.runId, run.id), eq(toolCalls.status, "awaiting_approval")))
          .limit(1);
        if (!stillWaiting) await transitionTask(tx, taskId, "running", {}, ["awaiting_approval"]);
      }
    });
  }

  /**
   * Called inside the transaction that recorded the run's outcome. Brings
   * the task to its next state: completed, cancelled, failed, interrupted,
   * queued again for an automatic retry (decideAfterFailure decides), or,
   * after a delegation, waiting for the delegated task (M5A).
   *
   * Delegation links: a child that completes, fails, or is cancelled tells
   * its parent (which may continue); a parent that stops cancels its waiting
   * children (stopped right after this transaction, see cancel.ts).
   */
  async function onAttemptEnded(tx: Queryable, run: RunRow, outcome: AttemptOutcome) {
    const taskId = run.taskId!;
    const attempt = run.attempt;
    const [task] = await tx
      .select({
        id: tasks.id,
        parentTaskId: tasks.parentTaskId,
        autoRetriesLeft: tasks.autoRetriesLeft,
        cancelRequestedAt: tasks.cancelRequestedAt,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .for("update");
    if (!task) return; // deleted with its agent

    if (outcome.status === "completed") {
      // A delegation made in this run: wait for it (or continue with its result) instead of completing.
      if (run.purpose === "work") {
        if (task.cancelRequestedAt) {
          // Cancel was pressed while the run finished; with a delegation pending, honour the cancel.
          if (await hasPendingDelegation(tx, taskId)) {
            await transitionTask(tx, taskId, "cancelled", { finishedAt: sql`now()` });
            await recordEvent(tx, taskId, run.id, "cancelled", "Cancelled before the delegated work could be finished.", { attempt });
            await markChildrenCancelled(tx, taskId);
            return;
          }
        } else if ((await onParentRunCompleted(tx, run, outcome.text)) !== "none") {
          return;
        }
      }
      const done = await transitionTask(tx, taskId, "completed", {
        result: outcome.text,
        errorCode: null,
        errorMessage: null,
        finishedAt: sql`now()`,
      });
      if (done) {
        await recordEvent(tx, taskId, run.id, "completed", "Completed. The result is saved.", { attempt });
        await onChildFinished(tx, task, { status: "completed" });
      } else {
        log("warn", "task.completion_not_applied", { taskId, runId: run.id });
      }
      return;
    }

    if (outcome.status === "cancelled") {
      if (await transitionTask(tx, taskId, "cancelled", { finishedAt: sql`now()` })) {
        await recordEvent(tx, taskId, run.id, "cancelled", `Cancelled. Attempt ${attempt} was stopped.`, { attempt });
        await onChildFinished(tx, task, { status: "cancelled" });
      }
      await markChildrenCancelled(tx, taskId);
      return;
    }

    // The owner already asked to cancel: the attempt ending any other way doesn't change that.
    if (task.cancelRequestedAt) {
      if (await transitionTask(tx, taskId, "cancelled", { finishedAt: sql`now()` })) {
        await recordEvent(tx, taskId, run.id, "cancelled", `Cancelled. Attempt ${attempt} ended before it could finish.`, {
          attempt,
          code: outcome.code,
        });
        await onChildFinished(tx, task, { status: "cancelled" });
      }
      await markChildrenCancelled(tx, taskId);
      return;
    }
    const calls = await tx
      .select({ toolId: toolCalls.toolId, status: toolCalls.status, requiresApproval: toolCalls.requiresApproval })
      .from(toolCalls)
      .where(eq(toolCalls.runId, run.id));
    const decision = decideAfterFailure(
      {
        code: outcome.code,
        attempt,
        autoRetriesLeft: task.autoRetriesLeft,
        sideEffectsMayHaveRun: calls.some((call) => !isReadOnlyTool(call.toolId) && MAY_HAVE_RUN.has(call.status)),
        // "cancelled" with a pending approval means the attempt stopped while the owner was deciding.
        approvalWasPending: calls.some(
          (call) => call.requiresApproval && (call.status === "awaiting_approval" || call.status === "cancelled"),
        ),
      },
      limits.retryBackoffMs,
    );
    await applyFailure(tx, run, task, outcome, decision);
  }

  async function applyFailure(
    tx: Queryable,
    run: RunRow,
    task: { id: string; parentTaskId: string | null; autoRetriesLeft: number },
    outcome: Extract<AttemptOutcome, { status: "failed" }>,
    decision: AfterFailure,
  ) {
    const taskId = run.taskId!;
    const attempt = run.attempt;
    const data = { attempt, code: outcome.code };

    if (decision.action === "retry") {
      const queued = await transitionTask(tx, taskId, "queued", { autoRetriesLeft: task.autoRetriesLeft - 1 }, [
        "running",
        "awaiting_approval",
      ]);
      if (!queued) return;
      const seconds = Math.round(decision.delayMs / 1000);
      const [retry] = await tx
        .insert(runs)
        .values({
          taskId,
          agentId: run.agentId,
          attempt: attempt + 1,
          // A retried follow-up is still a follow-up: it gets the delegated result, not the tool.
          purpose: run.purpose,
          // The database clock, like every other time the worker compares.
          notBefore: sql`now() + make_interval(secs => ${seconds})`,
        })
        .returning({ id: runs.id, notBefore: runs.notBefore });
      await recordEvent(
        tx,
        taskId,
        retry.id,
        "retry_scheduled",
        `Attempt ${attempt} ${RETRY_REASONS[outcome.code] ?? "failed"}. Nothing in it needs undoing, so Solas retries ` +
          `automatically as attempt ${attempt + 1} in ${seconds} s.`,
        { ...data, notBefore: retry.notBefore?.toISOString() },
      );
      return;
    }

    if (decision.action === "interrupt") {
      const message = INTERRUPT_MESSAGES[decision.reason];
      if (await transitionTask(tx, taskId, "interrupted", { errorCode: outcome.code, errorMessage: message, finishedAt: sql`now()` })) {
        await recordEvent(tx, taskId, run.id, "interrupted", `Attempt ${attempt} was interrupted. ${message}`, data);
        // A delegated task that's interrupted keeps its parent waiting: the owner retries or cancels it.
        await onChildInterrupted(tx, task);
      }
      await markChildrenCancelled(tx, taskId);
      return;
    }

    if (await transitionTask(tx, taskId, "failed", { errorCode: outcome.code, errorMessage: outcome.message, finishedAt: sql`now()` })) {
      await recordEvent(tx, taskId, run.id, "failed", `Attempt ${attempt} failed: ${outcome.message}`, data);
      await onChildFinished(tx, task, { status: "failed", message: outcome.message });
    }
    await markChildrenCancelled(tx, taskId);
  }

  return { recordEvent, onClaimed, loadTask, onStarted, onToolEvent, onAttemptEnded };
}

export type TaskRunHandlers = ReturnType<typeof createTaskRunHandlers>;

const RETRY_REASONS: Record<string, string> = {
  worker_stopped: "was cut off because the worker stopped",
  provider_unavailable: "couldn’t reach Claude",
};

const INTERRUPT_MESSAGES: Record<Extract<AfterFailure, { action: "interrupt" }>["reason"], string> = {
  approval_pending:
    "The worker stopped while an action waited for your approval. That request can’t be resumed, so nothing was " +
    "retried automatically. Use Retry to start a new attempt; it will ask again.",
  side_effects:
    "The worker stopped after an action that changes things may have run. Repeating it could do that twice, so " +
    "nothing was retried automatically. Check the result, then use Retry if you want a new attempt.",
  no_retries_left:
    "The worker stopped again, and the automatic retry was already used. Use Retry when the worker is running.",
};

/** How each tool step reads on the timeline. Built from Solas's own summaries. */
function toolEventMessage(event: ToolEvent): string {
  const { toolName, summary, detail } = event;
  switch (event.type) {
    case "tool_requested":
      return `Requested ${toolName}: ${summary}`;
    case "tool_denied":
      return `${toolName} was refused: it isn’t enabled for this agent.`;
    case "approval_requested":
      return `Waiting for your approval to run ${toolName}: ${summary}`;
    case "approval_granted":
      return `You approved ${toolName}.`;
    case "approval_rejected":
      return `You rejected ${toolName}. It did not run.`;
    case "approval_expired":
      return `The approval request for ${toolName} expired. It did not run.`;
    case "approval_cancelled":
      return `The approval request for ${toolName} was withdrawn because the attempt stopped. It did not run.`;
    case "tool_succeeded":
      return detail ? `${toolName} finished: ${detail}` : `${toolName} finished.`;
    case "tool_failed":
      return detail ? `${toolName} failed: ${detail}` : `${toolName} failed.`;
  }
}
