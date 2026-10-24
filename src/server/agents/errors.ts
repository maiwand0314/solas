import { z } from "zod";
import type { FieldErrors } from "@/lib/agents/validation";
import { classifyDatabaseError } from "@/server/db/errors";

export type { FieldErrors };

export type AgentErrorCode =
  | "validation_failed"
  | "not_found"
  | "name_taken"
  | "database_unavailable"
  | "unexpected";

/**
 * The only error type the agent service throws. `code` is stable and safe to
 * branch on; `message` is safe to show the owner; `cause` keeps the original
 * error for server logs.
 */
export class AgentServiceError extends Error {
  readonly name = "AgentServiceError";

  constructor(
    readonly code: AgentErrorCode,
    message: string,
    readonly fieldErrors: FieldErrors = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function validationError(error: z.ZodError): AgentServiceError {
  const { formErrors, fieldErrors } = z.flattenError(error);
  return new AgentServiceError(
    "validation_failed",
    formErrors[0] ?? "Some fields need attention.",
    fieldErrors as FieldErrors,
  );
}

export function notFoundError(): AgentServiceError {
  return new AgentServiceError("not_found", "This agent doesn’t exist. It may have been deleted.");
}

/** Maps a database error to an AgentServiceError the rest of the app understands. */
export function fromDatabaseError(error: unknown): AgentServiceError {
  const failure = classifyDatabaseError(error);
  switch (failure.kind) {
    case "unique_violation":
      return new AgentServiceError(
        "name_taken",
        "An agent with this name already exists.",
        { name: ["An agent with this name already exists."] },
        { cause: error },
      );
    case "check_violation":
      return new AgentServiceError("validation_failed", "The agent’s data is not valid.", {}, { cause: error });
    case "unavailable":
      return new AgentServiceError(
        "database_unavailable",
        "Can’t reach the database. Is PostgreSQL running? Start it with `npm run db:up`.",
        {},
        { cause: error },
      );
    case "unknown":
      return new AgentServiceError("unexpected", "Something went wrong while saving.", {}, { cause: error });
  }
}
