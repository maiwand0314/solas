"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { cancelTask, retryTask } from "@/app/(app)/tasks/actions";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { isActiveTaskStatus, type TaskStatusName } from "@/lib/tasks/status";

const RETRYABLE: readonly TaskStatusName[] = ["failed", "interrupted", "cancelled"];

type TaskActionsProps = {
  taskId: string;
  title: string;
  status: TaskStatusName;
  /** The owner already pressed Cancel; the worker hasn't confirmed yet. */
  cancelling: boolean;
  size?: "sm" | "md";
};

/**
 * Cancel (queued or running) and Retry (failed, interrupted, or cancelled).
 * Both go through the server, which re-checks the task's state: a Cancel on
 * a running task asks the worker to stop it, and the page shows "Cancelling…"
 * until the worker confirms. Nothing here changes what's shown on its own.
 */
export function TaskActions({ taskId, title, status, cancelling, size = "md" }: TaskActionsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function run(action: "cancel" | "retry") {
    if (pending) return;
    startTransition(async () => {
      try {
        const result = action === "cancel" ? await cancelTask(taskId) : await retryTask(taskId);
        if (!result.ok) {
          toast.error(result.error.message);
          return;
        }
        if (action === "retry") toast.success(`“${title}” is queued again.`);
        else if (result.data.status === "cancelled") toast.success(`Cancelled “${title}”.`);
        else toast.success("Cancelling. The worker stops the attempt within a few seconds.");
        router.refresh();
      } catch {
        toast.error("Couldn’t reach Solas. Check that it’s running, then try again.");
      }
    });
  }

  // The visible text starts the accessible name, so speech and screen readers agree with what's shown.
  if (isActiveTaskStatus(status)) {
    const label = cancelling || pending ? "Cancelling…" : "Cancel";
    return (
      <Button size={size} onClick={() => run("cancel")} disabled={pending || cancelling} aria-label={`${label} ${title}`}>
        {label}
      </Button>
    );
  }
  if (RETRYABLE.includes(status)) {
    const label = pending ? "Retrying…" : "Retry";
    return (
      <Button size={size} onClick={() => run("retry")} disabled={pending} aria-label={`${label} ${title}`}>
        {label}
      </Button>
    );
  }
  return null;
}
