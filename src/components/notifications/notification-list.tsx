"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationUnread,
} from "@/app/(app)/notifications/actions";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClassName } from "@/components/ui/button";
import { RelativeTime } from "@/components/ui/relative-time";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import type { NotificationView } from "@/server/notifications/service";

type Tone = "danger" | "warning" | "active" | "neutral";

const KIND: Record<NotificationView["kind"], { label: string; tone: Tone }> = {
  task_failed: { label: "Task failed", tone: "danger" },
  task_interrupted: { label: "Task interrupted", tone: "warning" },
  automation_missed: { label: "Missed run", tone: "warning" },
  automation_skipped: { label: "Run skipped", tone: "warning" },
  automation_paused: { label: "Paused", tone: "warning" },
  approval_requested: { label: "Approval needed", tone: "active" },
  approval_expired: { label: "Approval expired", tone: "neutral" },
  approval_rejected: { label: "Approval rejected", tone: "neutral" },
};

/** What the request looks like now. A request announced earlier may have been decided since. */
function approvalLabel(n: NotificationView): string | null {
  if (!n.approval || n.kind !== "approval_requested") return null;
  if (n.approval.open) return "Waiting for your decision";
  return { approved: "Approved", rejected: "Rejected", expired: "Expired" }[n.approval.status as string] ?? "No longer waiting";
}

export function NotificationList({ notifications }: { notifications: NotificationView[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const unread = notifications.filter((n) => !n.readAt).length;

  function run(id: string | null, action: () => ReturnType<typeof markAllNotificationsRead> | ReturnType<typeof markNotificationRead>) {
    if (pending) return;
    setBusyId(id);
    startTransition(async () => {
      try {
        const result = await action();
        if (!result.ok) toast.error(result.error.message);
        else router.refresh();
      } catch {
        toast.error("Couldn’t reach Solas. Try again.");
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm text-muted" aria-live="polite">
          {unread === 0 ? "You’re all caught up." : `${unread} unread`}
        </p>
        <Button size="sm" disabled={unread === 0 || pending} onClick={() => run(null, () => markAllNotificationsRead())}>
          Mark all as read
        </Button>
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {notifications.map((n) => {
          const kind = KIND[n.kind];
          const isUnread = !n.readAt;
          const state = approvalLabel(n);
          return (
            <li key={n.id} className={cn("flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-start sm:gap-4", isUnread && "bg-accent-subtle")}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Badge tone={kind.tone}>{kind.label}</Badge>
                  {state && <span className="text-xs text-muted">{state}</span>}
                  <span className="text-xs text-subtle">
                    <RelativeTime date={n.occurredAt} />
                  </span>
                  {isUnread && <span className="sr-only">Unread</span>}
                </div>
                <p className={cn("mt-1.5 break-words", isUnread ? "font-medium" : "text-muted")}>{n.title}</p>
                {n.body && <p className="mt-0.5 text-sm break-words text-muted">{n.body}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {n.href ? (
                  <Link
                    href={n.href}
                    onClick={() => {
                      // Opening the target counts as reading it; fire-and-forget so navigation isn't delayed.
                      if (isUnread) void markNotificationRead(n.id);
                    }}
                    className={buttonClassName({ size: "sm" })}
                  >
                    {n.kind === "approval_requested" && n.approval?.open ? "Review" : "Open"}
                  </Link>
                ) : (
                  <span className="text-xs text-subtle">Target deleted</span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending && busyId === n.id}
                  onClick={() => run(n.id, () => (isUnread ? markNotificationRead(n.id) : markNotificationUnread(n.id)))}
                >
                  {isUnread ? "Mark read" : "Mark unread"}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
