import { z } from "zod";
import type { FieldErrors } from "@/lib/agents/validation";
import { classifyDatabaseError } from "@/server/db/errors";

export type AutomationErrorCode =
  | "validation_failed"
  | "not_found"
  | "name_taken"
  | "agent_not_found"
  | "agent_unavailable"
  | "limit_reached"
  | "cannot_start"
  | "database_unavailable"
  | "unexpected";

/** The only error type the automation service throws. Same shape as the other services' errors. */
export class AutomationServiceError extends Error {
  readonly name = "AutomationServiceError";

  constructor(
    readonly code: AutomationErrorCode,
    message: string,
    readonly fieldErrors: FieldErrors = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function validationError(error: z.ZodError): AutomationServiceError {
  const { formErrors, fieldErrors } = z.flattenError(error);
  const first = formErrors[0] ?? Object.values(fieldErrors as FieldErrors)[0]?.[0];
  return new AutomationServiceError("validation_failed", first ?? "The automation isn’t valid.", fieldErrors as FieldErrors);
}

export function fromDatabaseError(error: unknown): AutomationServiceError {
  const failure = classifyDatabaseError(error);
  if (failure.kind === "unique_violation" && failure.constraint === "automations_name_lower_unique") {
    const message = "An automation with this name already exists.";
    return new AutomationServiceError("name_taken", message, { name: [message] }, { cause: error });
  }
  if (failure.kind === "unavailable") {
    return new AutomationServiceError(
      "database_unavailable",
      "Can’t reach the database. Is PostgreSQL running? Start it with `npm run db:up`.",
      {},
      { cause: error },
    );
  }
  return new AutomationServiceError("unexpected", "Something went wrong while saving.", {}, { cause: error });
}
