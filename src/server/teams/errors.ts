import { z } from "zod";
import type { FieldErrors } from "@/lib/agents/validation";
import { classifyDatabaseError } from "@/server/db/errors";

export type TeamErrorCode =
  | "validation_failed"
  | "not_found"
  | "name_taken"
  | "database_unavailable"
  | "unexpected";

/** The only error type the team service throws. Same shape as the other services' errors. */
export class TeamServiceError extends Error {
  readonly name = "TeamServiceError";

  constructor(
    readonly code: TeamErrorCode,
    message: string,
    readonly fieldErrors: FieldErrors = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function validationError(error: z.ZodError): TeamServiceError {
  const { formErrors, fieldErrors } = z.flattenError(error);
  const first = formErrors[0] ?? Object.values(fieldErrors as FieldErrors)[0]?.[0];
  return new TeamServiceError("validation_failed", first ?? "The team isn’t valid.", fieldErrors as FieldErrors);
}

export function fromDatabaseError(error: unknown): TeamServiceError {
  const failure = classifyDatabaseError(error);
  if (failure.kind === "unique_violation" && failure.constraint === "teams_name_lower_unique") {
    const message = "A team with this name already exists.";
    return new TeamServiceError("name_taken", message, { name: [message] }, { cause: error });
  }
  if (failure.kind === "unique_violation" && failure.constraint === "team_members_one_coordinator") {
    const message = "A team can have only one coordinator.";
    return new TeamServiceError("validation_failed", message, { coordinatorId: [message] }, { cause: error });
  }
  if (failure.kind === "unavailable") {
    return new TeamServiceError(
      "database_unavailable",
      "Can’t reach the database. Is PostgreSQL running? Start it with `npm run db:up`.",
      {},
      { cause: error },
    );
  }
  return new TeamServiceError("unexpected", "Something went wrong while saving.", {}, { cause: error });
}
