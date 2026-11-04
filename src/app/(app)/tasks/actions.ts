"use server";

// Server Actions for tasks. Creating a task only stores it and queues its
// first attempt; the worker process does the actual agent work. Approving or
// rejecting a task's tool call uses decideToolCall from the conversations
// actions: an approval is the same record wherever the run came from.

import { revalidatePath } from "next/cache";
import { toActionError, type ActionResult } from "@/server/actions/result";
import { requireOwner } from "@/server/auth/owner";
import { getTaskService } from "@/server/tasks/service";

async function guarded<T>(action: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    await requireOwner();
    const data = await action();
    revalidatePath("/tasks", "layout");
    return { ok: true, data };
  } catch (error) {
    return toActionError(error);
  }
}

export async function createTask(input: unknown): Promise<ActionResult<{ taskId: string }>> {
  return guarded(() => getTaskService().create(input));
}

export async function cancelTask(taskId: unknown): Promise<ActionResult<{ status: string }>> {
  return guarded(async () => ({ status: (await getTaskService().cancel(taskId)).status }));
}

export async function retryTask(taskId: unknown): Promise<ActionResult<{ status: string }>> {
  return guarded(async () => ({ status: (await getTaskService().retry(taskId)).status }));
}
