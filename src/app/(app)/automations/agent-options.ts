import "server-only";
import type { AutomationAgentOption } from "@/components/automations/automation-form";
import { listAgentsForOwner } from "@/server/agents/queries";
import { getAgentReadiness, providerRegistry } from "@/server/providers/registry";

/** Agents for the automation form, with whether each can run tasks now. */
export async function automationAgentOptions(): Promise<AutomationAgentOption[]> {
  const agents = await listAgentsForOwner();
  return agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    role: agent.role,
    ready: getAgentReadiness(agent, providerRegistry).state === "ready",
  }));
}
