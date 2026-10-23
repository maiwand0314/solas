// Turns low-level database errors into a few categories the app can act on.
// Drizzle wraps driver errors (error.cause), and connection failures can be
// AggregateErrors, so we look through the whole chain for a known code.

export type DatabaseFailure =
  | { kind: "unique_violation"; constraint?: string }
  | { kind: "check_violation"; constraint?: string }
  | { kind: "unavailable" }
  | { kind: "unknown" };

// https://www.postgresql.org/docs/current/errcodes-appendix.html
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "CONNECT_TIMEOUT", // postgres.js
  "CONNECTION_CLOSED", // postgres.js
  "CONNECTION_ENDED", // postgres.js
  "28P01", // invalid password
  "3D000", // database does not exist
  "57P01", // server shutting down
  "57P03", // server starting up
]);

type ErrorLike = { code?: unknown; constraint_name?: unknown; cause?: unknown; errors?: unknown };

function* errorChain(error: unknown, depth = 0): Generator<ErrorLike> {
  if (!error || typeof error !== "object" || depth > 5) return;
  const current = error as ErrorLike;
  yield current;
  if (Array.isArray(current.errors)) {
    for (const inner of current.errors) yield* errorChain(inner, depth + 1);
  }
  yield* errorChain(current.cause, depth + 1);
}

export function classifyDatabaseError(error: unknown): DatabaseFailure {
  for (const item of errorChain(error)) {
    if (typeof item.code !== "string") continue;
    const constraint = typeof item.constraint_name === "string" ? item.constraint_name : undefined;
    if (item.code === UNIQUE_VIOLATION) return { kind: "unique_violation", constraint };
    if (item.code === CHECK_VIOLATION) return { kind: "check_violation", constraint };
    // Class 08 is "connection exception".
    if (UNAVAILABLE_CODES.has(item.code) || item.code.startsWith("08")) return { kind: "unavailable" };
  }
  return { kind: "unknown" };
}
