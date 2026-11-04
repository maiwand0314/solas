"use server";

// Server Actions for automations. Each checks the owner first, then calls the
// automation service, and returns an ActionResult instead of throwing so
// forms can show errors. Run now creates a task, so task pages refresh too.

import { revalidatePath } from "next/cache";
import { toActionError, type ActionResult } from "@/server/actions/result";
import { requireOwner } from "@/server/auth/owner";
import { getAutomationService } from "@/server/automations/service";

async function guarded<T>(action: () => Promise<T>, refreshTasks = false): Promise<ActionResult<T>> {
  try {
    await requireOwner();
    const data = await action();
    revalidatePath("/automations", "layout");
    if (refreshTasks) revalidatePath("/tasks", "layout");
    return { ok: true, data };
  } catch (error) {
    return toActionError(error);
  }
}

export async function createAutomation(input: unknown): Promise<ActionResult<{ id: string; name: string }>> {
  return guarded(async () => {
    const { id, name } = await getAutomationService().create(input);
    return { id, name };
  });
}

export async function updateAutomation(id: unknown, input: unknown): Promise<ActionResult<{ id: string; name: string }>> {
  return guarded(async () => {
    const { id: savedId, name } = await getAutomationService().update(id, input);
    return { id: savedId, name };
  });
}

/** Pause (false) or resume (true). */
export async function setAutomationEnabled(id: unknown, enabled: boolean): Promise<ActionResult<{ enabled: boolean }>> {
  return guarded(async () => {
    const automation = await getAutomationService().setEnabled(id, enabled === true);
    return { enabled: automation.enabled };
  });
}

export async function deleteAutomation(id: unknown): Promise<ActionResult<null>> {
  return guarded(async () => {
    await getAutomationService().remove(id);
    return null;
  }, true);
}

export async function runAutomationNow(id: unknown): Promise<ActionResult<{ taskId: string }>> {
  return guarded(() => getAutomationService().runNow(id), true);
}
