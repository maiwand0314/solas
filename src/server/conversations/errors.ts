import { z } from "zod";
import type { FieldErrors } from "@/lib/agents/validation";
import { classifyDatabaseError } from "@/server/db/errors";

export type ConversationErrorCode =
  | "validation_failed"
  | "not_found"
  | "agent_not_found"
  | "agent_unavailable"
  | "run_in_progress"
  | "database_unavailable"
  | "unexpected";

/** The only error type the conversation service throws. Same shape as AgentServiceError. */
export class ConversationServiceError extends Error {
  readonly name = "ConversationServiceError";

  constructor(
    readonly code: ConversationErrorCode,
    message: string,
    readonly fieldErrors: FieldErrors = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function validationError(error: z.ZodError): ConversationServiceError {
  const { formErrors, fieldErrors } = z.flattenError(error);
  const first = formErrors[0] ?? Object.values(fieldErrors as FieldErrors)[0]?.[0];
  return new ConversationServiceError("validation_failed", first ?? "The message isn’t valid.", fieldErrors as FieldErrors);
}

export function fromDatabaseError(error: unknown): ConversationServiceError {
  const failure = classifyDatabaseError(error);
  if (failure.kind === "unique_violation" && failure.constraint === "runs_one_active_per_conversation") {
    return new ConversationServiceError(
      "run_in_progress",
      "The agent is still answering your last message. Wait for it, or stop it first.",
      {},
      { cause: error },
    );
  }
  if (failure.kind === "unavailable") {
    return new ConversationServiceError(
      "database_unavailable",
      "Can’t reach the database. Is PostgreSQL running? Start it with `npm run db:up`.",
      {},
      { cause: error },
    );
  }
  return new ConversationServiceError("unexpected", "Something went wrong while saving.", {}, { cause: error });
}
