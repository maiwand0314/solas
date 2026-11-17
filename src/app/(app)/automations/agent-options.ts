import "server-only";
import type { AutomationAgentOption, AutomationTeamOption } from "@/components/automations/automation-form";
import { listAgentsForOwner } from "@/server/agents/queries";
import { listTeamsForOwner } from "@/server/teams/queries";
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

/** Teams for the automation form. A team can run work only through a coordinator that is ready. */
export async function automationTeamOptions(agents: AutomationAgentOption[]): Promise<AutomationTeamOption[]> {
  const teams = await listTeamsForOwner();
  return teams.map((team) => ({
    id: team.id,
    name: team.name,
    coordinatorName: team.coordinator?.name ?? null,
    ready: team.coordinator ? (agents.find((agent) => agent.id === team.coordinator!.id)?.ready ?? false) : false,
  }));
}
