import "server-only";
import { requireOwner } from "@/server/auth/owner";
import { getAgentReadiness, providerRegistry } from "@/server/providers/registry";
import { getConversationService, type ConversationSummary, type ConversationThread } from "./service";

// Reads for Server Components. Each one checks the owner first, so a page
// can't forget to: pages import these, never the raw service.

export async function listConversationsForOwner(): Promise<ConversationSummary[]> {
  await requireOwner();
  return getConversationService().list();
}

export async function getConversationForOwner(id: unknown): Promise<ConversationThread> {
  await requireOwner();
  return getConversationService().get(id);
}

/** Why an agent can't chat right now, in words for the owner; null when it can. */
export function chatUnavailableReason(agent: {
  enabled: boolean;
  providerId: string | null;
  modelId: string | null;
}): string | null {
  const readiness = getAgentReadiness(agent, providerRegistry);
  if (readiness.state === "disabled") return "This agent is disabled. Enable it on its page to chat.";
  if (readiness.state === "unconfigured") return `${readiness.reason} Edit the agent and choose a model.`;
  return null;
}
