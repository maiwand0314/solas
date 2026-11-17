import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { LiveRefresh } from "@/components/live-refresh";
import { BellIcon } from "@/components/icons";
import { buttonClassName } from "@/components/ui/button";
import { unreadNotificationCountForOwner } from "@/server/notifications/queries";

const linkClass = buttonClassName({ variant: "ghost", size: "icon", className: "relative" });

/**
 * The bell in the header: a link to the inbox with the unread count, read
 * from the database. While the page is open it re-reads every 15 seconds
 * (LiveRefresh), so a new notification appears without a reload. It does not
 * notify while the browser is closed: the inbox is waiting when you return.
 */
export function NotificationBell() {
  return (
    <Suspense fallback={<BellLink unread={null} />}>
      <UnreadBell />
    </Suspense>
  );
}

async function UnreadBell() {
  let unread: number | null = null;
  try {
    unread = await unreadNotificationCountForOwner();
  } catch (error) {
    unstable_rethrow(error);
    // The bell must never break a page; the inbox page reports the real error.
  }
  return (
    <>
      <BellLink unread={unread} />
      <LiveRefresh active intervalMs={15_000} />
    </>
  );
}

function BellLink({ unread }: { unread: number | null }) {
  const label =
    unread === null || unread === 0
      ? "Notifications"
      : `Notifications, ${unread} unread`;
  return (
    <Link href="/notifications" aria-label={label} className={linkClass}>
      <BellIcon className="size-[18px]" />
      {unread !== null && unread > 0 && (
        <span
          aria-hidden="true"
          className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] leading-none font-semibold text-accent-foreground"
        >
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}
