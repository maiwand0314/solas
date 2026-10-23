import "server-only";
import { AgentServiceError, type AgentErrorCode, type FieldErrors } from "@/server/agents/errors";
import { OwnerAccessError } from "@/server/auth/owner";

// Server Actions return values instead of throwing, so forms can show
// field-level messages. Only plain, serializable data crosses to the browser:
// never stack traces, SQL, or the original error.

export type ActionErrorCode = AgentErrorCode | "forbidden";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ActionErrorCode; message: string; fieldErrors: FieldErrors } };

export function toActionError(error: unknown): Extract<ActionResult<never>, { ok: false }> {
  if (error instanceof OwnerAccessError) {
    return { ok: false, error: { code: "forbidden", message: error.message, fieldErrors: {} } };
  }
  if (error instanceof AgentServiceError) {
    if (error.code === "unexpected" || error.code === "database_unavailable") {
      // Keep the details in the server log, where the owner can look them up.
      console.error("[solas] agent action failed:", error.cause ?? error);
    }
    return {
      ok: false,
      error: { code: error.code, message: error.message, fieldErrors: error.fieldErrors },
    };
  }
  console.error("[solas] unexpected action error:", error);
  return {
    ok: false,
    error: { code: "unexpected", message: "Something went wrong. Check the server log.", fieldErrors: {} },
  };
}
