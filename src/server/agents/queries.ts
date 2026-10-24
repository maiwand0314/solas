import "server-only";
import { requireOwner } from "@/server/auth/owner";
import { getAgentService, type Agent } from "./service";

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
