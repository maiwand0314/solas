import { TaskStatusBadge } from "@/components/tasks/task-status-badge";
import { Badge } from "@/components/ui/badge";
import type { AutomationState, OccurrenceView } from "@/server/automations/service";

const STATES: Record<AutomationState, { label: string; tone: "success" | "neutral" | "warning" }> = {
  active: { label: "Active", tone: "success" },
  paused: { label: "Paused", tone: "neutral" },
  finished: { label: "Finished", tone: "neutral" },
  missed: { label: "Missed", tone: "warning" },
};

/** Whether an automation is scheduled, paused, done (one-time), or needs attention (a missed one-time run). */
export function AutomationStateBadge({ state }: { state: AutomationState }) {
  return <Badge tone={STATES[state].tone}>{STATES[state].label}</Badge>;
}

/**
 * The outcome of one run: the status of the task it started (the real,
 * current status from the database), or that it was missed or skipped.
 */
export function OccurrenceBadge({ occurrence }: { occurrence: Pick<OccurrenceView, "status" | "missedCount" | "task"> }) {
  if (occurrence.status === "missed") {
    return <Badge tone="warning">{occurrence.missedCount > 1 ? `Missed ×${occurrence.missedCount}` : "Missed"}</Badge>;
  }
  if (occurrence.status === "skipped") return <Badge tone="warning">Skipped</Badge>;
  if (!occurrence.task) return <Badge>Task deleted</Badge>;
  return <TaskStatusBadge status={occurrence.task.status} cancelling={occurrence.task.cancelRequestedAt !== null} />;
}
