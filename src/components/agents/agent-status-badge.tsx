import { Badge } from "@/components/ui/badge";

/**
 * Configuration state only: whether the owner has switched the agent on.
 * It says nothing about whether the agent is answering right now.
 */
export function AgentStatusBadge({ enabled }: { enabled: boolean }) {
  return enabled ? <Badge tone="success">Enabled</Badge> : <Badge>Disabled</Badge>;
}
