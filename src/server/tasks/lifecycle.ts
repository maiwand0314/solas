import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Database } from "@/server/db/client";
import { tasks, type TaskStatus } from "@/server/db/schema";

// The task state machine. A task's status changes only through
// transitionTask(), which allows a change only from the statuses listed
// here, checked by the database in the same UPDATE. Two processes racing to
// change one task can't both win, and a completed task can't be reopened.
//
//   queued ──claimed──▶ running ⇄ awaiting_approval
//     │                   │
//     │                   ├─▶ completed            (result saved)
//     │                   ├─▶ failed               (error saved)
//     │                   ├─▶ interrupted          (worker lost; not safe to repeat)
//     │                   ├─▶ cancelled            (owner's Cancel, confirmed by the worker)
//     │                   └─▶ queued               (automatic retry, when safe)
//     └─▶ cancelled       (Cancel before a worker took it)
//
//   failed / interrupted / cancelled ──owner's Retry──▶ queued
//   completed is final.

export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["awaiting_approval", "completed", "failed", "cancelled", "interrupted", "queued"],
  awaiting_approval: ["running", "completed", "failed", "cancelled", "interrupted", "queued"],
  completed: [],
  failed: ["queued"],
  cancelled: ["queued"],
  interrupted: ["queued"],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/** The statuses a task may be in to move to `to`. */
export function allowedFrom(to: TaskStatus): TaskStatus[] {
  return (Object.keys(TASK_TRANSITIONS) as TaskStatus[]).filter((from) => canTransition(from, to));
}

/** A database or an open transaction: both can run the same queries. */
export type Queryable = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Other columns to set with the status, e.g. the result or finishedAt (values or SQL). */
export type TaskChanges = Omit<PgUpdateSetSource<typeof tasks>, "id" | "status" | "agentId">;

/**
 * Moves a task to `to` if its current status allows it. Returns false (and
 * changes nothing) otherwise, e.g. when the owner cancelled it a moment ago.
 * Optionally also requires the current status to be one of `onlyFrom`.
 */
export async function transitionTask(
  db: Queryable,
  taskId: string,
  to: TaskStatus,
  changes: TaskChanges = {},
  onlyFrom?: readonly TaskStatus[],
): Promise<boolean> {
  const from = allowedFrom(to).filter((status) => !onlyFrom || onlyFrom.includes(status));
  if (from.length === 0) return false;
  const updated = await db
    .update(tasks)
    .set({ ...changes, status: to })
    .where(and(eq(tasks.id, taskId), inArray(tasks.status, from)))
    .returning({ id: tasks.id });
  return updated.length > 0;
}

/** What is known about an attempt that ended in failure. */
export type FailureFacts = {
  /** The run's error code, e.g. "worker_stopped" or "usage_limit". */
  code: string;
  /** Which attempt failed, from 1. */
  attempt: number;
  autoRetriesLeft: number;
  /** A tool with side effects was approved, started, or finished in this attempt. */
  sideEffectsMayHaveRun: boolean;
  /** A tool call was waiting for the owner's decision when the attempt ended. */
  approvalWasPending: boolean;
};

export type AfterFailure =
  | { action: "retry"; delayMs: number }
  | { action: "interrupt"; reason: "approval_pending" | "side_effects" | "no_retries_left" }
  | { action: "fail" };

/** Failures worth one more automatic try: nothing about the task itself was wrong. */
const RETRYABLE_CODES = new Set(["worker_stopped", "provider_unavailable"]);

/**
 * The retry policy. Only a lost worker or a provider outage is retried
 * automatically, and only when repeating the attempt is safe:
 *
 * - no tool with side effects may have run (it could happen twice);
 * - no approval was pending (the Claude session that asked can't be
 *   restored, and a new attempt would ask again, unprompted);
 * - the task has an automatic retry left (bounded, so nothing loops).
 *
 * Everything else needs the owner: a usage limit (retrying would only hit it
 * again), a timeout, a configuration problem, or an unsafe lost attempt,
 * which becomes "interrupted". Delays double with each attempt.
 */
export function decideAfterFailure(facts: FailureFacts, backoffMs: number): AfterFailure {
  if (!RETRYABLE_CODES.has(facts.code)) return { action: "fail" };
  const lostWorker = facts.code === "worker_stopped";
  if (facts.approvalWasPending) return lostWorker ? { action: "interrupt", reason: "approval_pending" } : { action: "fail" };
  if (facts.sideEffectsMayHaveRun) return lostWorker ? { action: "interrupt", reason: "side_effects" } : { action: "fail" };
  if (facts.autoRetriesLeft > 0) return { action: "retry", delayMs: backoffMs * 2 ** (facts.attempt - 1) };
  return lostWorker ? { action: "interrupt", reason: "no_retries_left" } : { action: "fail" };
}
