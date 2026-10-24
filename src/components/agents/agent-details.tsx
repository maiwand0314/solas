import type { ReactNode } from "react";
import { Callout } from "@/components/ui/callout";
import { PageHeader } from "@/components/ui/page-header";
import { RelativeTime } from "@/components/ui/relative-time";
import type { Agent } from "@/server/agents/service";
import type { ToolCatalogEntry } from "@/server/tools/types";
import { AgentHeaderActions, DeleteAgentSection } from "./agent-detail-actions";
import { AgentEnabledSwitch } from "./agent-enabled-switch";
import { AgentStatusBadge } from "./agent-status-badge";
import { BackLink } from "./back-link";

type AgentDetailsProps = {
  agent: Agent;
  /** "Provider · Model", or null when no model is configured. */
  modelLabel: string | null;
  /** The agent's enabled tools, in registry order. */
  tools: (Pick<ToolCatalogEntry, "id" | "name" | "risk" | "approval" | "capability"> & { mode: "allow" | "ask" })[];
  workspacePath: string;
};

/**
 * One agent's saved configuration. A Server Component: it renders on the
 * server from database data; only the controls inside it are client code.
 *
 * Future settings (tools, permissions, approvals, workspace, limits,
 * schedules, memory) each get their own section here, between "AI model"
 * and "Status", without changing the sections around them.
 */
export function AgentDetails({ agent, modelLabel, tools, workspacePath }: AgentDetailsProps) {
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
              <Callout>Choose a model (Edit) to chat with this agent.</Callout>
            )}
          </div>
        </DetailSection>

        <DetailSection title="Tools" description="Checked by Solas on every call.">
          {tools.length === 0 ? (
            <p className="text-muted">No tools. This agent can only reply with text.</p>
          ) : (
            <div className="flex flex-col gap-3">
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
                {tools.map((tool) => (
                  <li key={tool.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
                    <span className="font-medium">{tool.name}</span>
                    <span className="text-sm text-muted">
                      {tool.mode === "ask" || tool.approval === "required" ? "Asks you first" : "Runs automatically"}
                      {" · "}
                      {RISK_LABELS[tool.risk]}
                    </span>
                  </li>
                ))}
              </ul>
              {tools.some((tool) => tool.capability === "workspace-read") && (
                <p className="text-sm text-muted">
                  Workspace folder (read-only):{" "}
                  <code className="font-mono text-[0.8125rem] break-all text-foreground">{workspacePath}</code>
                </p>
              )}
            </div>
          )}
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

const RISK_LABELS: Record<ToolCatalogEntry["risk"], string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
};

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
