import type { WorkerStatus } from "@/server/workers/status";

export type WorkerSummary = {
  label: string;
  tone: "success" | "warning" | "danger" | "neutral";
  description: string;
};

/**
 * One line about the worker, shared by the header indicator and Settings.
 * "Stopped" is split by how the newest worker ended: a graceful stop is
 * normal; a heartbeat that just stopped means it crashed, was killed, or the
 * Mac slept.
 */
export function summarizeWorker(status: WorkerStatus): WorkerSummary {
  switch (status.state) {
    case "unavailable":
      return {
        label: "Status unavailable",
        tone: "warning",
        description: "Solas couldn’t read the database, so it can’t tell whether the worker is running. Check that PostgreSQL is up (npm run db:up).",
      };
    case "not_observed":
      return {
        label: "Not seen yet",
        tone: "neutral",
        description: "No worker has reported yet. Until one runs, nothing replies, no task runs, and no automation starts.",
      };
    case "healthy":
      return {
        label: "Running",
        tone: "success",
        description: "The worker is reporting, and its scheduler, notification sync, and recovery check are succeeding.",
      };
    case "degraded":
      return {
        label: "Degraded",
        tone: "warning",
        description: "The worker is alive, but one of its steps is failing or hasn’t succeeded for a while. Details below.",
      };
    case "stopped": {
      const newest = status.instances[0];
      return newest?.state === "stale"
        ? {
            label: "Not responding",
            tone: "danger",
            description: "The worker stopped reporting without shutting down: it crashed, was killed, or the Mac went to sleep. Nothing runs until a worker starts again.",
          }
        : {
            label: "Stopped",
            tone: "neutral",
            description: "The worker shut down normally. Nothing runs until it starts again; queued work waits in the database.",
          };
    }
  }
}
