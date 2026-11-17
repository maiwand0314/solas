import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDatabase, type Database } from "@/server/db/client";
import { NOTIFICATION_KINDS, notificationPreferences, type NotificationKind } from "@/server/db/schema";

// Notification preferences (M6C): which kinds create new inbox notifications.
// Every kind is on unless the owner turned it off. Muting a kind only stops
// new notifications of that kind: existing ones, approval cards on tasks and
// conversations, and every permission check stay exactly as they are.

export type NotificationPreference = { kind: NotificationKind; enabled: boolean };

const preferenceSchema = z.object({
  kind: z.enum(NOTIFICATION_KINDS, { error: "Unknown notification type." }),
  enabled: z.boolean({ error: "Choose on or off." }),
});

export function createNotificationPreferenceService({ db }: { db: Database }) {
  /** Every kind, in NOTIFICATION_KINDS order, with the default (on) where nothing was saved. */
  async function list(): Promise<NotificationPreference[]> {
    const rows = await db.select().from(notificationPreferences);
    const saved = new Map(rows.map((row) => [row.kind, row.enabled]));
    return NOTIFICATION_KINDS.map((kind) => ({ kind, enabled: saved.get(kind) ?? true }));
  }

  /**
   * Saves one choice. changed_at moves only when the value actually changes:
   * it is the line the sync won't look behind, so turning a kind on twice
   * doesn't hide events between the two clicks.
   */
  async function set(input: unknown): Promise<NotificationPreference> {
    const { kind, enabled } = preferenceSchema.parse(input);
    await db
      .insert(notificationPreferences)
      .values({ kind, enabled })
      .onConflictDoUpdate({
        target: notificationPreferences.kind,
        set: { enabled, changedAt: sql`now()` },
        setWhere: sql`${notificationPreferences.enabled} is distinct from excluded.enabled`,
      });
    return { kind, enabled };
  }

  return { list, set };
}

export type NotificationPreferenceService = ReturnType<typeof createNotificationPreferenceService>;

export function getNotificationPreferenceService(): NotificationPreferenceService {
  return createNotificationPreferenceService({ db: getDatabase() });
}
