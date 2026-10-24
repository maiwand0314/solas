import "server-only";
import { notFound, unstable_rethrow } from "next/navigation";
import { AgentServiceError } from "@/server/agents/errors";
import { getAgentForOwner } from "@/server/agents/queries";
import type { Agent } from "@/server/agents/service";

/**
 * Loads one agent for a page. A missing agent, or an id that isn't a UUID,
 * shows the not-found page; other failures are returned for the page to show.
 */
export async function loadAgent(agentId: string): Promise<{ agent: Agent } | { error: unknown }> {
  try {
    return { agent: await getAgentForOwner(agentId) };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof AgentServiceError && (error.code === "not_found" || error.code === "validation_failed")) {
      notFound();
    }
    return { error };
  }
}
