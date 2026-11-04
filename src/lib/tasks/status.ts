// Task statuses as the owner sees them: labels, tones, and the filters on the
// Tasks page. Client-safe (no database code), so lists and badges share it.
// The statuses themselves are defined with the schema (TASK_STATUSES).

export type TaskStatusName =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "waiting_on_delegate"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type StatusTone = "neutral" | "active" | "success" | "warning" | "danger";

export const TASK_STATUS_DISPLAY: Record<TaskStatusName, { label: string; tone: StatusTone }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "active" },
  awaiting_approval: { label: "Waiting for approval", tone: "warning" },
  waiting_on_delegate: { label: "Waiting on agent", tone: "active" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  interrupted: { label: "Interrupted", tone: "warning" },
};

/** A task in one of these is still being worked on (or waiting to be). */
export const ACTIVE_TASK_STATUSES: readonly TaskStatusName[] = ["queued", "running", "awaiting_approval", "waiting_on_delegate"];

export function isActiveTaskStatus(status: TaskStatusName): boolean {
  return ACTIVE_TASK_STATUSES.includes(status);
}

/** The filters on the Tasks page, in order. Each maps to one or more statuses. */
export const TASK_FILTERS = [
  { id: "all", label: "All", statuses: null },
  { id: "queued", label: "Queued", statuses: ["queued"] },
  { id: "running", label: "Running", statuses: ["running", "waiting_on_delegate"] },
  { id: "awaiting_approval", label: "Awaiting approval", statuses: ["awaiting_approval"] },
  { id: "completed", label: "Completed", statuses: ["completed"] },
  { id: "failed", label: "Failed", statuses: ["failed"] },
  { id: "stopped", label: "Cancelled / Interrupted", statuses: ["cancelled", "interrupted"] },
] as const satisfies readonly { id: string; label: string; statuses: readonly TaskStatusName[] | null }[];

export type TaskFilterId = (typeof TASK_FILTERS)[number]["id"];

/** Reads ?status= from the URL; anything unknown means "all". */
export function parseTaskFilter(value: unknown): TaskFilterId {
  return TASK_FILTERS.find((filter) => filter.id === value)?.id ?? "all";
}
