"use server";

// Server Actions for conversations. Sending a message only stores it and
// queues a run; the worker process does the actual agent work. The web app
// never calls Claude.

import { revalidatePath } from "next/cache";
import { toActionError, type ActionResult } from "@/server/actions/result";
import { requireOwner } from "@/server/auth/owner";
import { getConversationService, type RunState } from "@/server/conversations/service";

async function guarded<T>(action: () => Promise<T>, refresh: boolean): Promise<ActionResult<T>> {
  try {
    await requireOwner();
    const data = await action();
    if (refresh) revalidatePath("/conversations", "layout");
    return { ok: true, data };
  } catch (error) {
    return toActionError(error);
  }
}

export async function sendMessage(input: unknown): Promise<ActionResult<{ conversationId: string; runId: string }>> {
  return guarded(() => getConversationService().sendMessage(input), true);
}

export async function cancelRun(runId: unknown): Promise<ActionResult<RunState>> {
  return guarded(() => getConversationService().cancelRun(runId), true);
}

/** Polled by the conversation view while a reply is pending or running. */
export async function getRunState(runId: unknown): Promise<ActionResult<RunState>> {
  return guarded(() => getConversationService().getRun(runId), false);
}
