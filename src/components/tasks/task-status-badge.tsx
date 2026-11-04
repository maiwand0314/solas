import { Badge } from "@/components/ui/badge";
import { isActiveTaskStatus, TASK_STATUS_DISPLAY, type TaskStatusName } from "@/lib/tasks/status";

/**
 * A task's real status as text with a colored dot. While the owner's Cancel
 * waits for the worker to stop the attempt, it says so ("Cancelling…")
 * instead of pretending the task already stopped.
 */
export function TaskStatusBadge({ status, cancelling = false }: { status: TaskStatusName; cancelling?: boolean }) {
  if (cancelling && isActiveTaskStatus(status)) return <Badge tone="neutral">Cancelling…</Badge>;
  const { label, tone } = TASK_STATUS_DISPLAY[status];
  return <Badge tone={tone}>{label}</Badge>;
}
