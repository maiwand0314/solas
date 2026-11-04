import "server-only";
import { runs, tasks, type TaskEventData } from "@/server/db/schema";
import { recordTaskEvent } from "./events";
import type { Queryable } from "./lifecycle";

export type NewTask = {
  agentId: string;
  title: string;
  instructions: string;
  teamId?: string | null;
  /** Set when an automation created the task (M6A). */
  automationId?: string | null;
  clientRequestId?: string;
  autoRetries: number;
  /** The first line of the task's timeline: who created it, and why. */
  createdMessage: string;
  createdData?: TaskEventData;
};

/**
 * Inserts a task and its first attempt (a pending run the worker will
 * claim), with the "created" and "queued" events. Call it inside a
 * transaction. The one way tasks start, whether the owner or an automation
 * asks, so both get the same queue, permissions, and timeline.
 */
export async function insertTaskWithFirstRun(tx: Queryable, input: NewTask): Promise<{ taskId: string; runId: string }> {
  const [task] = await tx
    .insert(tasks)
    .values({
      agentId: input.agentId,
      title: input.title,
      instructions: input.instructions,
      clientRequestId: input.clientRequestId,
      teamId: input.teamId ?? null,
      automationId: input.automationId ?? null,
      autoRetriesLeft: input.autoRetries,
    })
    .returning({ id: tasks.id });
  const [run] = await tx.insert(runs).values({ taskId: task.id, agentId: input.agentId, attempt: 1 }).returning({ id: runs.id });
  await recordTaskEvent(tx, { taskId: task.id, type: "created", message: input.createdMessage, data: input.createdData });
  await recordTaskEvent(tx, {
    taskId: task.id,
    runId: run.id,
    type: "queued",
    message: "Queued as attempt 1. It starts when the worker picks it up.",
    data: { attempt: 1 },
  });
  return { taskId: task.id, runId: run.id };
}
