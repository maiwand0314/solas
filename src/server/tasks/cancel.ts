import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { runs, taskDelegations, tasks, type TaskRow } from "@/server/db/schema";
import type { Logger } from "@/server/logger";
import { truncate } from "@/server/logger";
import { markChildrenCancelled, onChildFinished } from "./delegation";
import { recordTaskEvent } from "./events";
import { transitionTask, type Queryable } from "./lifecycle";
import { TaskServiceError } from "./errors";

// Cancelling a task, shared by the owner's Cancel (web) and the worker
// (stopping children whose parent stopped). One place, so both follow the
// same rules and the same lock order (run, then task).

export type CancelResult = {
  task: TaskRow;
  /** Child tasks whose delegation was cancelled: stop them after this transaction (stopOrphanedChildren). */
  childrenToStop: string[];
};

/**
 * Cancels one task inside a transaction.
 * - queued, waiting_on_delegate, interrupted: cancelled at once.
 * - running / awaiting_approval: a cancel request the worker acts on within
 *   about a second; the task stays running ("Cancelling…") until it has.
 * A child cancelled at once tells its parent (which then continues). A
 * parent's waiting children are marked for stopping, whatever the branch.
 */
export async function cancelTaskInTx(tx: Queryable, taskId: string, by: "owner" | "parent"): Promise<CancelResult> {
  const [active] = await tx
    .select({ id: runs.id, status: runs.status, attempt: runs.attempt })
    .from(runs)
    .where(and(eq(runs.taskId, taskId), inArray(runs.status, ["pending", "running"])))
    .for("update");
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).limit(1).for("update");
  if (!task) throw new TaskServiceError("not_found", "This task doesn’t exist. It may have been deleted with its agent.");

  const who = by === "owner" ? "You cancelled this task" : "Cancelled because the task that delegated it stopped";
  let cancelledNow = false;

  if (task.status === "queued" || task.status === "waiting_on_delegate" || task.status === "interrupted") {
    if (active?.status === "pending") {
      await tx.update(runs).set({ status: "cancelled", finishedAt: sql`now()` }).where(eq(runs.id, active.id));
    }
    await transitionTask(tx, taskId, "cancelled", { finishedAt: sql`now()` });
    await recordTaskEvent(tx, {
      taskId,
      runId: active?.id,
      type: "cancelled",
      message: task.status === "queued" ? `${who} before it started.` : `${who}.`,
    });
    cancelledNow = true;
  } else if (task.status === "running" || task.status === "awaiting_approval") {
    if (!task.cancelRequestedAt) {
      if (active?.status === "running") {
        await tx.update(runs).set({ cancelRequestedAt: sql`now()` }).where(eq(runs.id, active.id));
      }
      await tx.update(tasks).set({ cancelRequestedAt: sql`now()` }).where(eq(tasks.id, taskId));
      await recordTaskEvent(tx, {
        taskId,
        runId: active?.id,
        type: "cancel_requested",
        message: active
          ? `${by === "owner" ? "You asked to cancel" : "The task that delegated this one stopped"}. Waiting for the worker to stop attempt ${active.attempt}.`
          : "Cancel requested.",
        data: active ? { attempt: active.attempt } : {},
      });
    }
  } else if (by === "owner") {
    throw new TaskServiceError("invalid_state", "Only a queued, running, waiting, or interrupted task can be cancelled.");
  }

  if (cancelledNow && task.parentTaskId) await onChildFinished(tx, task, { status: "cancelled" });
  // A parent's children stop with it, whether it stopped now or will within a second.
  const childrenToStop = await markChildrenCancelled(tx, taskId);
  const [updated] = await tx.select().from(tasks).where(eq(tasks.id, taskId));
  return { task: updated, childrenToStop };
}

/**
 * Stops child tasks whose delegation was cancelled (their parent stopped)
 * but which are still queued, running, waiting, or interrupted. Each in its
 * own transaction, in the child's lock order. Called right after a parent
 * stops, and by the worker every recovery interval, so a child left behind
 * by a crash between the two steps is still stopped.
 */
export async function stopOrphanedChildren(db: Database, log: Logger, parentTaskId?: string): Promise<number> {
  const orphans = await db
    .select({ id: tasks.id })
    .from(taskDelegations)
    .innerJoin(tasks, eq(tasks.id, taskDelegations.childTaskId))
    .where(
      and(
        eq(taskDelegations.status, "cancelled"),
        inArray(tasks.status, ["queued", "running", "awaiting_approval", "waiting_on_delegate", "interrupted"]),
        isNull(tasks.cancelRequestedAt),
        parentTaskId ? eq(taskDelegations.parentTaskId, parentTaskId) : undefined,
      ),
    );
  let stopped = 0;
  for (const { id } of orphans) {
    try {
      await db.transaction((tx) => cancelTaskInTx(tx, id, "parent"));
      stopped++;
    } catch (error) {
      log("warn", "task.child_not_stopped", { taskId: id, error: truncate(error instanceof Error ? error.message : String(error)) });
    }
  }
  return stopped;
}
