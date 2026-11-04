import "server-only";
import { notFound, unstable_rethrow } from "next/navigation";
import { TeamServiceError } from "@/server/teams/errors";
import { getTeamForOwner } from "@/server/teams/queries";
import type { TeamDetail } from "@/server/teams/service";

/** Loads one team for a page: a missing team or a bad ID shows not-found; other failures are returned. */
export async function loadTeam(teamId: string): Promise<{ detail: TeamDetail } | { error: unknown }> {
  try {
    return { detail: await getTeamForOwner(teamId) };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof TeamServiceError && (error.code === "not_found" || error.code === "validation_failed")) notFound();
    return { error };
  }
}
