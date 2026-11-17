import "server-only";
import { requireOwner } from "@/server/auth/owner";
import { getNotificationService, type NotificationView } from "./service";

// Reads for Server Components; each checks the owner first.

export async function listNotificationsForOwner(): Promise<NotificationView[]> {
  await requireOwner();
  return getNotificationService().list();
}

export async function unreadNotificationCountForOwner(): Promise<number> {
  await requireOwner();
  return getNotificationService().unreadCount();
}
