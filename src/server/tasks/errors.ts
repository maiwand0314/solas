import { z } from "zod";
import type { FieldErrors } from "@/lib/agents/validation";
import { classifyDatabaseError } from "@/server/db/errors";

export type TaskErrorCode =
  | "validation_failed"
  | "not_found"
  | "agent_not_found"
  | "agent_unavailable"
  | "invalid_state"
  | "duplicate_request"
  | "database_unavailable"
  | "unexpected";

/** The only error type the task service throws. Same shape as the other services' errors. */
export class TaskServiceError extends Error {
  readonly name = "TaskServiceError";

  constructor(
    readonly code: TaskErrorCode,
    message: string,
    readonly fieldErrors: FieldErrors = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function validationError(error: z.ZodError): TaskServiceError {
  const { formErrors, fieldErrors } = z.flattenError(error);
  const first = formErrors[0] ?? Object.values(fieldErrors as FieldErrors)[0]?.[0];
  return new TaskServiceError("validation_failed", first ?? "The task isn’t valid.", fieldErrors as FieldErrors);
}

export function fromDatabaseError(error: unknown): TaskServiceError {
  const failure = classifyDatabaseError(error);
  if (failure.kind === "unique_violation" && failure.constraint === "tasks_client_request_id_unique") {
    // Not shown to the owner: create() turns it into "already created".
    return new TaskServiceError("duplicate_request", "This task was already created.", {}, { cause: error });
  }
  if (failure.kind === "unique_violation" && failure.constraint === "runs_one_active_per_task") {
    return new TaskServiceError("invalid_state", "This task already has an attempt queued or running.", {}, { cause: error });
  }
  if (failure.kind === "unavailable") {
    return new TaskServiceError(
      "database_unavailable",
      "Can’t reach the database. Is PostgreSQL running? Start it with `npm run db:up`.",
      {},
      { cause: error },
    );
  }
  return new TaskServiceError("unexpected", "Something went wrong while saving.", {}, { cause: error });
}
