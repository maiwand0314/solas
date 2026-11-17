"use server";

// Server Actions for the Notification Center: owner check first, then a
// read-state change. They return an ActionResult so the UI can show errors.

import { revalidatePath } from "next/cache";
import { toActionError, type ActionResult } from "@/server/actions/result";
import { requireOwner } from "@/server/auth/owner";
import { getNotificationPreferenceService, type NotificationPreference } from "@/server/notifications/preferences";
import { getNotificationService } from "@/server/notifications/service";

async function guarded<T>(action: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    await requireOwner();
    const data = await action();
    // The bell is in the layout of every page.
    revalidatePath("/", "layout");
    return { ok: true, data };
  } catch (error) {
    return toActionError(error);
  }
}

export async function markNotificationRead(id: unknown): Promise<ActionResult<null>> {
  return guarded(async () => {
    await getNotificationService().markRead(id);
    return null;
  });
}

export async function markNotificationUnread(id: unknown): Promise<ActionResult<null>> {
  return guarded(async () => {
    await getNotificationService().markUnread(id);
    return null;
  });
}

export async function markAllNotificationsRead(): Promise<ActionResult<{ count: number }>> {
  return guarded(async () => ({ count: await getNotificationService().markAllRead() }));
}

/** Turns one notification kind on or off (M6C). Only future notifications are affected. */
export async function setNotificationPreference(kind: unknown, enabled: unknown): Promise<ActionResult<NotificationPreference>> {
  try {
    await requireOwner();
    const saved = await getNotificationPreferenceService().set({ kind, enabled });
    revalidatePath("/settings");
    return { ok: true, data: saved };
  } catch (error) {
    return toActionError(error);
  }
}
