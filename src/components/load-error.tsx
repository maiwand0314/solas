import { Callout } from "@/components/ui/callout";
import { AgentServiceError } from "@/server/agents/errors";
import { OwnerAccessError } from "@/server/auth/owner";
import { AutomationServiceError } from "@/server/automations/errors";
import { ConversationServiceError } from "@/server/conversations/errors";
import { TaskServiceError } from "@/server/tasks/errors";
import { TeamServiceError } from "@/server/teams/errors";
import { RetryButton } from "./retry-button";

/**
 * What a page shows when its data can't be loaded. Known problems get a clear
 * message and a way forward; anything else is logged on the server and shown
 * generically, without internal details.
 */
const SUBJECT_LABELS = {
  agents: "Agents",
  conversations: "Conversations",
  tasks: "Tasks",
  teams: "Teams",
  automations: "Automations",
} as const;

export function LoadError({ error, subject = "agents" }: { error: unknown; subject?: keyof typeof SUBJECT_LABELS }) {
  if (error instanceof OwnerAccessError) {
    return (
      <Callout tone="danger" title="Access denied">
        {error.message}
      </Callout>
    );
  }
  if (
    (error instanceof AgentServiceError ||
      error instanceof ConversationServiceError ||
      error instanceof TaskServiceError ||
      error instanceof TeamServiceError ||
      error instanceof AutomationServiceError) &&
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
      {SUBJECT_LABELS[subject]} couldn’t be loaded. Check the server log for details.
    </Callout>
  );
}
