import Link from "next/link";
import { Badge } from "@/components/ui/badge";

export type PickableAgent = {
  id: string;
  name: string;
  role: string;
  modelLabel: string | null;
  /** Why the agent can't chat right now, or null when it can. */
  unavailableReason: string | null;
};

/**
 * Choose which agent to talk to. Agents that can't answer are listed too,
 * with the reason, so nothing silently disappears.
 */
export function AgentPicker({ agents }: { agents: PickableAgent[] }) {
  return (
    <ul aria-label="Agents" className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
      {agents.map((agent) => (
        <li
          key={agent.id}
          className="relative flex items-center gap-4 px-4 py-3.5 transition-colors duration-100 hover:bg-surface-hover/60"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              {/* The whole row links: to the chat when the agent can answer, else to the agent. */}
              <Link
                href={agent.unavailableReason ? `/agents/${agent.id}` : `/conversations/new?agent=${agent.id}`}
                className="truncate font-medium text-foreground after:absolute after:inset-0 after:content-['']"
              >
                {agent.name}
              </Link>
              <span className="truncate text-sm text-muted">{agent.role}</span>
            </div>
            <p className="mt-0.5 text-sm text-muted">{agent.unavailableReason ?? agent.modelLabel}</p>
          </div>
          {agent.unavailableReason ? <Badge>Can’t chat</Badge> : <Badge tone="success">Ready</Badge>}
        </li>
      ))}
    </ul>
  );
}
