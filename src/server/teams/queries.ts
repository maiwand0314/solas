import "server-only";
import { requireOwner } from "@/server/auth/owner";
import { getTeamService, type TeamDetail, type TeamOption, type TeamSummary } from "./service";

// Reads for Server Components. Each one checks the owner first, so a page
// can't forget to: pages import these, never the raw service.

export async function listTeamsForOwner(): Promise<TeamSummary[]> {
  await requireOwner();
  return getTeamService().list();
}

export async function getTeamForOwner(id: unknown): Promise<TeamDetail> {
  await requireOwner();
  return getTeamService().get(id);
}

export async function getAgentTeamsForOwner(agentId: string) {
  await requireOwner();
  return getTeamService().teamsOfAgent(agentId);
}

export async function listTeamOptionsForOwner(): Promise<TeamOption[]> {
  await requireOwner();
  return getTeamService().options();
}
