import "server-only";
import { createHash } from "node:crypto";
import { and, asc, eq, isNull, max, sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import {
  agentDelegationTargets,
  agents,
  runs,
  taskDelegations,
  tasks,
  type RunRow,
  type TaskDelegationRow,
} from "@/server/db/schema";
import { getAgentReadiness, type ProviderRegistry } from "@/server/providers/registry";
import { DELEGATION_LIMITS } from "@/server/runs/config";
import { ToolError, type DelegationReceipt, type DelegationRequest } from "@/server/tools/types";
import { recordTaskEvent } from "./events";
import { transitionTask, type Queryable } from "./lifecycle";

// Delegation between agents (M5A). One agent's task hands a subtask to
// another agent; the subtask is an ordinary task (a "child") linked to the
// first (its "parent"), so it runs on the same queue, worker, and runtime,
// as the other agent, with that agent's own tools and approvals.
//
// The parent never waits inside a worker slot. Its run ends after it
// delegates; the task waits as "waiting_on_delegate"; when the child
// finishes, a follow-up run ("continue") is queued with the child's result.
// So a parent and its child can't block each other, even with one worker.
//
//   parent run ── delegate_to_agent ──▶ child task (queued)
//   parent run ends ──▶ parent: waiting_on_delegate
//   child runs, finishes ──▶ delegation completed/failed/cancelled
//                        ──▶ parent: queued with a "continue" run
//   continue run: task + parent's notes + child's result ──▶ final result
//
// Lock order, everywhere: a task's run, then the task, then (for a child)
// its parent task, then delegation rows. The parent's side never locks a
// child's rows in the same transaction (children are stopped afterwards,
// see cancel.ts), so the two sides can't deadlock.

export type DelegationLimits = typeof DELEGATION_LIMITS;

/** Terminal outcomes of a child task that its parent hears about. */
type ChildOutcome = { status: "completed" } | { status: "failed"; message: string } | { status: "cancelled" };

/**
 * The parent's delegation request, checked and carried out in one
 * transaction with the parent task locked. Every rule is enforced here, in
 * the backend; what the model wrote in the request can't change them.
 * Throws ToolError (shown to the model) when the request isn't allowed.
 */
export async function delegate(
  db: Database,
  {
    run,
    request,
    providers,
    limits = DELEGATION_LIMITS,
    autoRetries,
  }: { run: RunRow; request: DelegationRequest; providers: ProviderRegistry; limits?: DelegationLimits; autoRetries: number },
): Promise<DelegationReceipt> {
  if (!run.taskId) throw new ToolError("Only tasks can delegate, not conversations.");
  const parentTaskId = run.taskId;

  return db.transaction(async (tx) => {
    const [parent] = await tx.select().from(tasks).where(eq(tasks.id, parentTaskId)).for("update");
    if (!parent) throw new ToolError("This task no longer exists.");
    if ((parent.status !== "running" && parent.status !== "awaiting_approval") || parent.cancelRequestedAt) {
      throw new ToolError("This task is stopping, so it can’t delegate.");
    }
    if (parent.depth >= limits.maxDepth) {
      throw new ToolError("A delegated task can’t delegate again. Do this part yourself.");
    }
    if (request.targetAgentId === run.agentId) throw new ToolError("An agent can’t delegate to itself.");

    // Permission: an explicit target row for this agent. It also proves the target exists.
    const [allowed] = await tx
      .select({ targetAgentId: agentDelegationTargets.targetAgentId })
      .from(agentDelegationTargets)
      .where(and(eq(agentDelegationTargets.agentId, run.agentId), eq(agentDelegationTargets.targetAgentId, request.targetAgentId)))
      .limit(1);
    if (!allowed) {
      throw new ToolError("You may not delegate to that agent. Use one of the agents listed in this tool’s description.");
    }
    const [target] = await tx.select().from(agents).where(eq(agents.id, request.targetAgentId)).limit(1);
    if (!target) throw new ToolError("That agent no longer exists.");
    const readiness = getAgentReadiness(target, providers);
    if (readiness.state === "disabled") throw new ToolError(`${target.name} is disabled, so it can’t take tasks.`);
    if (readiness.state === "unconfigured") throw new ToolError(`${target.name} has no model, so it can’t take tasks.`);

    // Idempotency and budget.
    const requestHash = hashRequest(request);
    const existing = await tx
      .select()
      .from(taskDelegations)
      .where(eq(taskDelegations.parentTaskId, parentTaskId))
      .orderBy(asc(taskDelegations.createdAt));
    const same = existing.find((delegation) => delegation.requestHash === requestHash);
    if (same) return receiptFor(tx, same, "This exact request was already made.");
    // Waiting or completed children count; a failed or cancelled one doesn't block a fresh try after a retry.
    const counted = existing.filter((delegation) => delegation.status === "waiting" || delegation.status === "completed");
    if (counted.length >= limits.maxChildrenPerTask) {
      return receiptFor(
        tx,
        counted[0],
        `This task may delegate ${limits.maxChildrenPerTask === 1 ? "once" : `${limits.maxChildrenPerTask} times`}, and it already has.`,
      );
    }

    // Create the child task, its first attempt, and the link, together.
    const [parentAgent] = await tx.select({ name: agents.name }).from(agents).where(eq(agents.id, run.agentId));
    const title = titleFrom(request.taskDescription);
    const [child] = await tx
      .insert(tasks)
      .values({
        agentId: target.id,
        title,
        instructions: childInstructions(parentAgent?.name ?? "Another agent", request),
        parentTaskId,
        depth: parent.depth + 1,
        autoRetriesLeft: autoRetries,
      })
      .returning({ id: tasks.id });
    const [childRun] = await tx.insert(runs).values({ taskId: child.id, agentId: target.id, attempt: 1 }).returning({ id: runs.id });
    const [delegation] = await tx
      .insert(taskDelegations)
      .values({
        parentTaskId,
        parentRunId: run.id,
        parentAgentId: run.agentId,
        targetAgentId: target.id,
        childTaskId: child.id,
        taskDescription: request.taskDescription,
        expectedOutput: request.expectedOutput ?? null,
        requestHash,
      })
      .returning();
    const links = { delegationId: delegation.id, childTaskId: child.id, parentTaskId };
    await recordTaskEvent(tx, {
      taskId: child.id,
      runId: childRun.id,
      type: "created",
      message: `${parentAgent?.name ?? "Another agent"} delegated this task from “${parent.title}”.`,
      data: links,
    });
    await recordTaskEvent(tx, {
      taskId: child.id,
      runId: childRun.id,
      type: "queued",
      message: "Queued as attempt 1. It starts when the worker picks it up.",
      data: { attempt: 1 },
    });
    await recordTaskEvent(tx, {
      taskId: parentTaskId,
      runId: run.id,
      type: "delegated",
      message: `Delegated to ${target.name}: ${title}`,
      data: links,
    });
    return {
      delegationId: delegation.id,
      childTaskId: child.id,
      agentName: target.name,
      status: "queued",
      message:
        `Delegated to ${target.name} as a separate task. End your turn now with a short note of what you have done ` +
        `so far. Solas gives you ${target.name}’s result in a follow-up, and you then finish the task.`,
    };
  });
}

/** What the model is told about an existing delegation. Hands over a finished result at once. */
async function receiptFor(tx: Queryable, delegation: TaskDelegationRow, why: string): Promise<DelegationReceipt> {
  const [child] = await tx
    .select({ status: tasks.status, result: tasks.result, errorMessage: tasks.errorMessage, agentName: agents.name })
    .from(tasks)
    .innerJoin(agents, eq(agents.id, tasks.agentId))
    .where(eq(tasks.id, delegation.childTaskId));
  const base = { delegationId: delegation.id, childTaskId: delegation.childTaskId, agentName: child?.agentName ?? "The agent" };
  const name = base.agentName;

  if (delegation.status === "waiting") {
    return {
      ...base,
      status: "waiting",
      message: `${why} ${name} is still working on it. End your turn with a short note; Solas gives you the result in a follow-up.`,
    };
  }
  // A finished delegation: its outcome is handed over now, so no follow-up run is needed for it.
  await tx.update(taskDelegations).set({ resultDeliveredAt: sql`now()` }).where(eq(taskDelegations.id, delegation.id));
  if (delegation.status === "completed") {
    return {
      ...base,
      status: "completed",
      message: `${why} ${name} already finished it. Its result is included; use it to finish the task.`,
      result: limitResult(child?.result ?? ""),
    };
  }
  return {
    ...base,
    status: delegation.status,
    message:
      `${why} ${name}’s task ${delegation.status === "failed" ? `failed: ${child?.errorMessage ?? "no reason recorded"}` : "was cancelled"}. ` +
      "Finish the task yourself, or explain what is missing.",
  };
}

/**
 * Called when a parent's "work" run completed (inside the transaction that
 * recorded it, with the parent task already locked). If a delegated task is
 * still working, the parent waits for it, holding no worker slot. If one
 * already finished, the follow-up run is queued straight away.
 */
export async function onParentRunCompleted(
  tx: Queryable,
  run: RunRow,
  text: string,
  limits: DelegationLimits = DELEGATION_LIMITS,
): Promise<"waiting" | "continued" | "none"> {
  const taskId = run.taskId!;
  const delegations = await tx
    .select()
    .from(taskDelegations)
    .where(eq(taskDelegations.parentTaskId, taskId))
    .for("update");
  const waiting = delegations.filter((delegation) => delegation.status === "waiting");
  const undelivered = delegations.filter((delegation) => delegation.status !== "waiting" && !delegation.resultDeliveredAt);
  if (waiting.length === 0 && undelivered.length === 0) return "none";

  // Keep what the parent wrote, to give back with the result (bounded, newest kept).
  const notes = text.length > limits.maxParentNotesChars ? `…${text.slice(-limits.maxParentNotesChars)}` : text;
  for (const delegation of [...waiting, ...undelivered]) {
    await tx.update(taskDelegations).set({ parentNotes: notes }).where(eq(taskDelegations.id, delegation.id));
  }

  if (waiting.length > 0) {
    if (!(await transitionTask(tx, taskId, "waiting_on_delegate", {}, ["running"]))) return "none";
    const names = await agentNames(tx, waiting.map((delegation) => delegation.targetAgentId));
    await recordTaskEvent(tx, {
      taskId,
      runId: run.id,
      type: "waiting_on_delegate",
      message: `Waiting for ${names} to finish the delegated task. No worker is held while it waits.`,
      data: { attempt: run.attempt },
    });
    return "waiting";
  }
  return (await queueContinuation(tx, taskId)) ? "continued" : "none";
}

/**
 * Called when a child task reaches completed, failed, or cancelled (inside
 * the transaction that recorded it). Records the outcome on the delegation
 * and, if the parent is waiting, queues the parent's follow-up run.
 * An interrupted child doesn't count: the parent keeps waiting until the
 * owner retries or cancels it.
 */
export async function onChildFinished(tx: Queryable, child: { id: string; parentTaskId: string | null }, outcome: ChildOutcome) {
  if (!child.parentTaskId) return;
  const [parent] = await tx
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, child.parentTaskId))
    .for("update");
  const [delegation] = await tx
    .select()
    .from(taskDelegations)
    .where(eq(taskDelegations.childTaskId, child.id))
    .for("update");
  if (!parent || !delegation || delegation.status !== "waiting") return;

  await tx
    .update(taskDelegations)
    .set({ status: outcome.status, completedAt: sql`now()` })
    .where(eq(taskDelegations.id, delegation.id));
  const name = await agentNames(tx, [delegation.targetAgentId]);
  const message =
    outcome.status === "completed"
      ? `${name} completed the delegated task.`
      : outcome.status === "failed"
        ? `${name}’s delegated task failed: ${outcome.message}`
        : `${name}’s delegated task was cancelled.`;
  await recordTaskEvent(tx, {
    taskId: parent.id,
    type: "delegate_finished",
    message,
    data: { childTaskId: child.id, delegationId: delegation.id, code: outcome.status },
  });
  if (parent.status === "waiting_on_delegate") await queueContinuation(tx, parent.id);
}

/**
 * Tells a waiting parent that its child was interrupted, so the owner knows
 * why nothing moves. The parent keeps waiting.
 */
export async function onChildInterrupted(tx: Queryable, child: { id: string; parentTaskId: string | null }) {
  if (!child.parentTaskId) return;
  const [delegation] = await tx
    .select({ id: taskDelegations.id, targetAgentId: taskDelegations.targetAgentId })
    .from(taskDelegations)
    .where(eq(taskDelegations.childTaskId, child.id));
  if (!delegation) return;
  const name = await agentNames(tx, [delegation.targetAgentId]);
  await recordTaskEvent(tx, {
    taskId: child.parentTaskId,
    type: "delegate_finished",
    message: `${name}’s delegated task was interrupted. Retry or cancel it to let this task continue.`,
    data: { childTaskId: child.id, delegationId: delegation.id, code: "interrupted" },
  });
}

/**
 * The parent stopped (cancelled, failed, interrupted), so its waiting
 * children have no one to report to. Marks those delegations cancelled and
 * returns the children to stop. Stopping them happens after this
 * transaction (stopOrphanedChildren), in the children's own lock order.
 */
export async function markChildrenCancelled(tx: Queryable, parentTaskId: string): Promise<string[]> {
  const cancelled = await tx
    .update(taskDelegations)
    .set({ status: "cancelled", completedAt: sql`now()`, resultDeliveredAt: sql`now()` })
    .where(and(eq(taskDelegations.parentTaskId, parentTaskId), eq(taskDelegations.status, "waiting")))
    .returning({ childTaskId: taskDelegations.childTaskId });
  if (cancelled.length > 0) {
    await recordTaskEvent(tx, {
      taskId: parentTaskId,
      type: "delegate_finished",
      message: "Cancelled the delegated task, because this task stopped.",
      data: { childTaskId: cancelled[0].childTaskId, code: "cancelled" },
    });
  }
  return cancelled.map((row) => row.childTaskId);
}

/** True when the task has a delegation still working, or finished but not yet handed to it. */
export async function hasPendingDelegation(tx: Queryable, taskId: string): Promise<boolean> {
  const rows = await tx
    .select({ status: taskDelegations.status, resultDeliveredAt: taskDelegations.resultDeliveredAt })
    .from(taskDelegations)
    .where(eq(taskDelegations.parentTaskId, taskId));
  return rows.some((row) => row.status === "waiting" || !row.resultDeliveredAt);
}

/** True when a child's delegation was cancelled: the child must not start. */
export async function isDelegationCancelled(tx: Queryable, childTaskId: string): Promise<boolean> {
  const [delegation] = await tx
    .select({ status: taskDelegations.status })
    .from(taskDelegations)
    .where(eq(taskDelegations.childTaskId, childTaskId));
  return delegation?.status === "cancelled";
}

/** What a parent's follow-up run is given, per delegation. */
export type ContinuationInput = {
  agentName: string;
  agentRole: string;
  taskDescription: string;
  expectedOutput: string | null;
  parentNotes: string | null;
  outcome: "completed" | "failed" | "cancelled";
  result: string | null;
  errorMessage: string | null;
};

/** The finished delegations of a task, for its follow-up prompt. */
export async function loadContinuation(db: Queryable, taskId: string): Promise<ContinuationInput[]> {
  const rows = await db
    .select({
      agentName: agents.name,
      agentRole: agents.role,
      taskDescription: taskDelegations.taskDescription,
      expectedOutput: taskDelegations.expectedOutput,
      parentNotes: taskDelegations.parentNotes,
      status: taskDelegations.status,
      result: tasks.result,
      errorMessage: tasks.errorMessage,
    })
    .from(taskDelegations)
    .innerJoin(tasks, eq(tasks.id, taskDelegations.childTaskId))
    .innerJoin(agents, eq(agents.id, taskDelegations.targetAgentId))
    .where(eq(taskDelegations.parentTaskId, taskId))
    .orderBy(asc(taskDelegations.createdAt));
  return rows
    .filter((row) => row.status !== "waiting")
    .map(({ status, result, ...row }) => ({
      ...row,
      outcome: status as ContinuationInput["outcome"],
      result: result === null ? null : limitResult(result),
    }));
}

/** Moves the parent back to queued with a "continue" run, and marks the results as handed over. */
async function queueContinuation(tx: Queryable, parentTaskId: string): Promise<boolean> {
  const queued = await transitionTask(tx, parentTaskId, "queued", {}, ["running", "awaiting_approval", "waiting_on_delegate"]);
  if (!queued) return false;
  const [parent] = await tx
    .select({ agentId: tasks.agentId, agentName: agents.name })
    .from(tasks)
    .innerJoin(agents, eq(agents.id, tasks.agentId))
    .where(eq(tasks.id, parentTaskId));
  const [{ latest }] = await tx.select({ latest: max(runs.attempt) }).from(runs).where(eq(runs.taskId, parentTaskId));
  const attempt = (latest ?? 0) + 1;
  const [run] = await tx
    .insert(runs)
    .values({ taskId: parentTaskId, agentId: parent.agentId, attempt, purpose: "continue" })
    .returning({ id: runs.id });
  await tx
    .update(taskDelegations)
    .set({ resultDeliveredAt: sql`now()` })
    .where(and(eq(taskDelegations.parentTaskId, parentTaskId), isNull(taskDelegations.resultDeliveredAt)));
  await recordTaskEvent(tx, {
    taskId: parentTaskId,
    runId: run.id,
    type: "continuation_queued",
    message: `Queued ${parent.agentName} to finish the task with the delegated result (attempt ${attempt}).`,
    data: { attempt },
  });
  return true;
}

async function agentNames(tx: Queryable, ids: string[]): Promise<string> {
  const names: string[] = [];
  for (const id of ids) {
    const [agent] = await tx.select({ name: agents.name }).from(agents).where(eq(agents.id, id));
    names.push(agent?.name ?? "the other agent");
  }
  return names.join(", ");
}

/** Same target and same words: the same request, however often it arrives. */
export function hashRequest({ targetAgentId, taskDescription, expectedOutput }: DelegationRequest): string {
  return createHash("sha256")
    .update(JSON.stringify([targetAgentId, taskDescription.trim(), (expectedOutput ?? "").trim()]))
    .digest("hex");
}

function limitResult(result: string): string {
  const max = DELEGATION_LIMITS.maxChildResultChars;
  return result.length > max ? `${result.slice(0, max)}\n\n[The rest of the result was cut to keep this short.]` : result;
}

/** The child's title: the first line of what it was asked, shortened. */
function titleFrom(description: string): string {
  const line = description.trim().split("\n")[0].trim();
  return line.length > 100 ? `${line.slice(0, 99).trimEnd()}…` : line;
}

/**
 * The child task's instructions: exactly what the parent sent, plus one line
 * saying where it came from. Nothing else from the parent (its instructions,
 * the owner's task, files, conversations) is passed on.
 */
function childInstructions(parentAgentName: string, request: DelegationRequest): string {
  return [
    request.taskDescription.trim(),
    ...(request.expectedOutput ? ["", `Expected output: ${request.expectedOutput.trim()}`] : []),
    "",
    `(Delegated to you by ${parentAgentName}, another agent in Solas. Reply with the finished result; it goes back to ${parentAgentName}.)`,
  ].join("\n");
}
