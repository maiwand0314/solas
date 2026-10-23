import "server-only";
import { headers } from "next/headers";

export class OwnerAccessError extends Error {
  readonly name = "OwnerAccessError";
}

/** Host names that only reach this machine. Ports are ignored. */
export function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  const hostname = host.trim().toLowerCase().replace(/:\d+$/, "");
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Every Server Action that reads or changes owner data calls this first.
 *
 * Solas has no sign-in yet (that's M9), so this fails closed: it allows a
 * request only when
 *   1. SOLAS_LOCAL_OWNER_MODE is exactly "true" (set in .env.local, never on a
 *      server), and
 *   2. the request was addressed to this machine (Host is localhost,
 *      127.0.0.1, or [::1]). This also blocks DNS-rebinding attacks, where a
 *      website open in your browser tries to reach your local server under its
 *      own host name.
 *
 * M9 replaces the body with a real session check. Callers won't change.
 */
export async function requireOwner(): Promise<void> {
  if (process.env.SOLAS_LOCAL_OWNER_MODE !== "true") {
    throw new OwnerAccessError("Changes are disabled: Solas has no sign-in yet and local owner mode is off.");
  }
  const host = (await headers()).get("host");
  if (!isLoopbackHost(host)) {
    throw new OwnerAccessError("Changes are only allowed from this computer until sign-in exists.");
  }
}
