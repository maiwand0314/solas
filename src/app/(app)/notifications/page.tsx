import type { Metadata } from "next";
import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { AgentListSkeleton } from "@/components/agents/agent-skeletons";
import { BellIcon } from "@/components/icons";
import { LiveRefresh } from "@/components/live-refresh";
import { LoadError } from "@/components/load-error";
import { NotificationList } from "@/components/notifications/notification-list";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { listNotificationsForOwner } from "@/server/notifications/queries";

export const metadata: Metadata = {
  title: "Notifications",
};

export default function NotificationsPage() {
  return (
    <>
      <PageHeader
        title="Notifications"
        description="Failed tasks, missed or paused automations, and approvals waiting for you. Saved in the database, so they stay after a refresh or a worker restart. Solas only shows them here: nothing is sent to you while this page is closed."
      />
      <Suspense fallback={<AgentListSkeleton />}>
        <Inbox />
      </Suspense>
    </>
  );
}

async function Inbox() {
  let notifications;
  try {
    notifications = await listNotificationsForOwner();
  } catch (error) {
    unstable_rethrow(error);
    return <LoadError error={error} subject="notifications" />;
  }
  if (notifications.length === 0) {
    return (
      <EmptyState
        icon={BellIcon}
        title="Nothing to review"
        description="When a task fails, an automation misses a run, or an agent needs your approval, it shows up here."
      />
    );
  }
  return (
    <>
      <NotificationList notifications={notifications} />
      <LiveRefresh active intervalMs={15_000} />
    </>
  );
}
