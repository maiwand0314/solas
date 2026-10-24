import type { ReactNode } from "react";
import { Callout } from "@/components/ui/callout";
import { PageHeader } from "@/components/ui/page-header";
import { RelativeTime } from "@/components/ui/relative-time";
import type { Agent } from "@/server/agents/service";
import { AgentHeaderActions, DeleteAgentSection } from "./agent-detail-actions";
import { AgentEnabledSwitch } from "./agent-enabled-switch";
import { AgentStatusBadge } from "./agent-status-badge";
import { BackLink } from "./back-link";

type AgentDetailsProps = {
  agent: Agent;
  /** "Provider · Model", or null when no model is configured. */
  modelLabel: string | null;
};

/**
 * One agent's saved configuration. A Server Component: it renders on the
 * server from database data; only the controls inside it are client code.
 *
 * Future settings (tools, permissions, approvals, workspace, limits,
 * schedules, memory) each get their own section here, between "AI model"
 * and "Status", without changing the sections around them.
 */
export function AgentDetails({ agent, modelLabel }: AgentDetailsProps) {
  const ref = { id: agent.id, name: agent.name };
  return (
    <>
      <BackLink href="/agents">Agents</BackLink>
      <PageHeader
        title={agent.name}
        badge={<AgentStatusBadge enabled={agent.enabled} />}
        description={agent.role}
        actions={<AgentHeaderActions agent={ref} />}
      />

      <div className="divide-y divide-border">
        <DetailSection title="Identity">
          <dl className="grid gap-4 sm:grid-cols-[8rem_1fr]">
            <dt className="text-sm text-subtle">Role</dt>
            <dd>{agent.role}</dd>
            <dt className="text-sm text-subtle">Description</dt>
            <dd className={agent.description ? undefined : "text-subtle"}>
              {agent.description || "No description"}
            </dd>
          </dl>
        </DetailSection>

        <DetailSection title="Instructions" description="Followed in every task.">
          <div className="rounded-lg border border-border bg-surface px-4 py-3.5 text-reading break-words whitespace-pre-wrap">
            {agent.instructions}
          </div>
        </DetailSection>

        <DetailSection title="AI model">
          <div className="flex flex-col gap-3">
            <p className={modelLabel ? "font-medium" : "font-medium text-muted"}>{modelLabel ?? "Not configured"}</p>
            {!modelLabel && (
              <Callout>AI execution will be available once the Agent Engine is connected.</Callout>
            )}
          </div>
        </DetailSection>

        <DetailSection title="Status" description="A setting, not a run state.">
          {/* key: reset the optimistic state when the saved value changes */}
          <AgentEnabledSwitch key={String(agent.enabled)} agent={agent} />
        </DetailSection>

        <DetailSection title="Record">
          <dl className="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="text-subtle">Created</dt>
            <dd>
              <RelativeTime date={agent.createdAt} />
            </dd>
            <dt className="text-subtle">Last updated</dt>
            <dd>
              <RelativeTime date={agent.updatedAt} />
            </dd>
            <dt className="text-subtle">Agent ID</dt>
            <dd className="font-mono text-xs break-all text-muted">{agent.id}</dd>
          </dl>
        </DetailSection>

        <DetailSection title="Delete">
          <DeleteAgentSection agent={ref} />
        </DetailSection>
      </div>
    </>
  );
}

function DetailSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3 py-6 first:pt-0 lg:grid-cols-[14rem_1fr] lg:gap-10">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}
