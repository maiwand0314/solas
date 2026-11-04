import "server-only";
import { requireOwner } from "@/server/auth/owner";
import type { AgentToolSetting } from "@/lib/agents/validation";
import { getAgentService, type Agent, type DelegationTarget } from "./service";

// Reads for Server Components. Each one checks the owner first, so a page
// can't forget to: pages import these, never the raw service.

export async function listAgentsForOwner(): Promise<Agent[]> {
  await requireOwner();
  return getAgentService().list();
}

export async function getAgentForOwner(id: unknown): Promise<Agent> {
  await requireOwner();
  return getAgentService().get(id);
}

export async function getAgentToolsForOwner(id: unknown): Promise<AgentToolSetting[]> {
  await requireOwner();
  return getAgentService().getTools(id);
}

export async function getAgentDelegationTargetsForOwner(id: unknown): Promise<DelegationTarget[]> {
  await requireOwner();
  return getAgentService().getDelegationTargets(id);
}
