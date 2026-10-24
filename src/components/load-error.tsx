import { Callout } from "@/components/ui/callout";
import { AgentServiceError } from "@/server/agents/errors";
import { OwnerAccessError } from "@/server/auth/owner";
import { ConversationServiceError } from "@/server/conversations/errors";
import { RetryButton } from "./retry-button";

/**
 * What a page shows when its data can't be loaded. Known problems get a clear
 * message and a way forward; anything else is logged on the server and shown
 * generically, without internal details.
 */
export function LoadError({ error, subject = "agents" }: { error: unknown; subject?: "agents" | "conversations" }) {
  if (error instanceof OwnerAccessError) {
    return (
      <Callout tone="danger" title="Access denied">
        {error.message}
      </Callout>
    );
  }
  if (
    (error instanceof AgentServiceError || error instanceof ConversationServiceError) &&
    error.code === "database_unavailable"
  ) {
    return (
      <Callout tone="danger" title={`Can’t load ${subject}`} actions={<RetryButton />}>
        {error.message}
      </Callout>
    );
  }
  console.error(`[solas] failed to load ${subject}:`, error);
  return (
    <Callout tone="danger" title="Something went wrong" actions={<RetryButton />}>
      {subject === "agents" ? "Agents" : "Conversations"} couldn’t be loaded. Check the server log for details.
    </Callout>
  );
}
