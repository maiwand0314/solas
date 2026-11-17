import "server-only";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDatabase, type Database } from "@/server/db/client";
import { notifications, toolCalls, type NotificationRow, type ToolCallStatus } from "@/server/db/schema";

// The Notification Center from the web app's side (M6B): read the inbox and
// change read state. Creating notifications is the worker's sync (sync.ts).
// Marking read/unread only sets read_at; it never touches the event itself.

/** For an approval notification: the request as it stands now, not when it was announced. */
export type ApprovalState = {
  status: ToolCallStatus;
  /** Still waiting, and the window hasn't closed (checked by the database clock). */
  open: boolean;
  expiresAt: Date | null;
};

export type NotificationView = Pick<NotificationRow, "id" | "kind" | "title" | "body" | "occurredAt" | "readAt"> & {
  /** Where the notification leads, or null if its target was deleted. */
  href: string | null;
  approval: ApprovalState | null;
};

const idSchema = z.uuid({ error: "Invalid notification." });
export const INBOX_LIMIT = 100;

export function hrefOf(n: Pick<NotificationRow, "taskId" | "conversationId" | "automationId">): string | null {
  if (n.taskId) return `/tasks/${n.taskId}`;
  if (n.conversationId) return `/conversations/${n.conversationId}`;
  if (n.automationId) return `/automations/${n.automationId}`;
  return null;
}

export function createNotificationService({ db }: { db: Database }) {
  async function list(): Promise<NotificationView[]> {
    const rows = await db
      .select({
        n: notifications,
        callStatus: toolCalls.status,
        open: sql<boolean>`${toolCalls.status} = 'awaiting_approval' and ${toolCalls.approvalExpiresAt} > now()`,
        expiresAt: toolCalls.approvalExpiresAt,
      })
      .from(notifications)
      .leftJoin(toolCalls, eq(toolCalls.id, notifications.toolCallId))
      .orderBy(desc(notifications.occurredAt), desc(notifications.createdAt))
      .limit(INBOX_LIMIT);
    return rows.map(({ n, callStatus, open, expiresAt }) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      occurredAt: n.occurredAt,
      readAt: n.readAt,
      href: hrefOf(n),
      // A pending request whose time ran out shows as expired even before the worker records it.
      approval: callStatus
        ? { status: callStatus === "awaiting_approval" && !open ? "expired" : callStatus, open: open === true, expiresAt }
        : null,
    }));
  }

  async function unreadCount(): Promise<number> {
    const [{ unread }] = await db.select({ unread: count() }).from(notifications).where(isNull(notifications.readAt));
    return unread;
  }

  /** Idempotent: marking an already-read notification read keeps its first read time. */
  async function markRead(id: unknown): Promise<void> {
    const notificationId = idSchema.parse(id);
    await db
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(and(eq(notifications.id, notificationId), isNull(notifications.readAt)));
  }

  async function markUnread(id: unknown): Promise<void> {
    await db.update(notifications).set({ readAt: null }).where(eq(notifications.id, idSchema.parse(id)));
  }

  async function markAllRead(): Promise<number> {
    const updated = await db
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(isNull(notifications.readAt))
      .returning({ id: notifications.id });
    return updated.length;
  }

  return { list, unreadCount, markRead, markUnread, markAllRead };
}

export type NotificationService = ReturnType<typeof createNotificationService>;

export function getNotificationService(): NotificationService {
  return createNotificationService({ db: getDatabase() });
}
