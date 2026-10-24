"use server";

// Server Actions for conversations. Sending a message only stores it and
// queues a run; the worker process does the actual agent work. The web app
// never calls Claude.

import { revalidatePath } from "next/cache";
import { toActionError, type ActionResult } from "@/server/actions/result";
import { requireOwner } from "@/server/auth/owner";
import { getConversationService, type RunState, type SendResult } from "@/server/conversations/service";

/**
 * "all": the list and every conversation page. "list": only /conversations,
 * so a deleted conversation's own page isn't re-rendered (it would flash
 * "not found" before the browser moves on).
 */
type Refresh = "all" | "list" | "none";

async function guarded<T>(action: () => Promise<T>, refresh: Refresh): Promise<ActionResult<T>> {
  try {
    await requireOwner();
    const data = await action();
    if (refresh === "all") revalidatePath("/conversations", "layout");
    if (refresh === "list") revalidatePath("/conversations");
    return { ok: true, data };
  } catch (error) {
    return toActionError(error);
  }
}

export async function sendMessage(input: unknown): Promise<ActionResult<SendResult>> {
  return guarded(() => getConversationService().sendMessage(input), "all");
}

/** Asks again after the latest reply failed or was stopped. */
export async function retryRun(runId: unknown): Promise<ActionResult<SendResult>> {
  return guarded(() => getConversationService().retryRun(runId), "all");
}

export async function renameConversation(id: unknown, title: unknown): Promise<ActionResult<{ title: string }>> {
  return guarded(async () => ({ title: (await getConversationService().rename(id, title)).title }), "all");
}

export async function deleteConversation(id: unknown): Promise<ActionResult<null>> {
  return guarded(async () => {
    await getConversationService().remove(id);
    return null;
  }, "list");
}

export async function cancelRun(runId: unknown): Promise<ActionResult<RunState>> {
  return guarded(() => getConversationService().cancelRun(runId), "all");
}

/** Polled by the conversation view while a reply is pending or running. */
export async function getRunState(runId: unknown): Promise<ActionResult<RunState>> {
  return guarded(() => getConversationService().getRun(runId), "none");
}
