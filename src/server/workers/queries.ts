import "server-only";
import { requireOwner } from "@/server/auth/owner";
import { jsonLogger as log, truncate } from "@/server/logger";
import { getWorkerStatusService, type WorkerStatus } from "./status";

/**
 * Worker status for Server Components, owner first. A database that can't be
 * read is a status of its own ("unavailable"), not an error page: it is
 * exactly what the owner needs to see when the worker seems gone.
 */
export async function getWorkerStatusForOwner(): Promise<WorkerStatus> {
  await requireOwner();
  try {
    return await getWorkerStatusService().read();
  } catch (error) {
    log("error", "worker_status.read_failed", { error: truncate(error instanceof Error ? error.message : String(error)) });
    return { state: "unavailable" };
  }
}
