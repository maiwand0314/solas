import "server-only";
import { taskEvents, type TaskEventData, type TaskEventType } from "@/server/db/schema";
import type { Queryable } from "./lifecycle";

/**
 * Appends one event to a task's timeline. Used by the web app (created,
 * cancel requested, retried) and the worker (everything during an attempt),
 * inside the same transaction as the change it describes.
 */
export async function recordTaskEvent(
  db: Queryable,
  event: { taskId: string; runId?: string | null; type: TaskEventType; message: string; data?: TaskEventData },
) {
  await db.insert(taskEvents).values({
    taskId: event.taskId,
    runId: event.runId ?? null,
    type: event.type,
    message: event.message,
    data: event.data ?? {},
  });
}
