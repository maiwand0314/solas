"use server";

// Server Actions for teams. Each checks the owner first, then calls the team
// service, and returns an ActionResult instead of throwing so forms can show
// errors. Delegation edits change agents too, so agent pages are refreshed.

import { revalidatePath } from "next/cache";
import { toActionError, type ActionResult } from "@/server/actions/result";
import { requireOwner } from "@/server/auth/owner";
import { getTeamService, type TeamMemberView } from "@/server/teams/service";

async function guarded<T>(action: () => Promise<T>, refreshAgents = false): Promise<ActionResult<T>> {
  try {
    await requireOwner();
    const data = await action();
    revalidatePath("/teams", "layout");
    if (refreshAgents) revalidatePath("/agents", "layout");
    return { ok: true, data };
  } catch (error) {
    return toActionError(error);
  }
}

export async function createTeam(input: unknown): Promise<ActionResult<{ id: string; name: string }>> {
  return guarded(async () => {
    const { id, name } = await getTeamService().create(input);
    return { id, name };
  }, true);
}

export async function updateTeam(id: unknown, input: unknown): Promise<ActionResult<{ id: string; name: string }>> {
  return guarded(async () => {
    const team = await getTeamService().update(id, input);
    return { id: team.id, name: team.name };
  }, true);
}

export async function deleteTeam(id: unknown): Promise<ActionResult<null>> {
  return guarded(async () => {
    await getTeamService().remove(id);
    return null;
  }, true);
}

/** One member's delegation targets inside the team (the M5A permission). */
export async function setTeamDelegation(id: unknown, input: unknown): Promise<ActionResult<TeamMemberView[]>> {
  return guarded(() => getTeamService().setDelegation(id, input), true);
}
