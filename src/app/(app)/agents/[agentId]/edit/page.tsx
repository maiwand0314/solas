import type { Metadata } from "next";
import { Suspense } from "react";
import { AgentForm } from "@/components/agents/agent-form";
import { LoadError } from "@/components/load-error";
import { AgentDetailsSkeleton } from "@/components/agents/agent-skeletons";
import { BackLink } from "@/components/agents/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { getAgentDelegationTargetsForOwner, getAgentToolsForOwner, listAgentsForOwner } from "@/server/agents/queries";
import { providerRegistry } from "@/server/providers/registry";
import { toolRegistry } from "@/server/tools/registry";
import { displayWorkspacePath } from "@/server/tools/workspace";
import { loadAgent } from "../load-agent";

export const metadata: Metadata = {
  title: "Edit agent",
};

export default function EditAgentPage({ params }: PageProps<"/agents/[agentId]/edit">) {
  return (
    <Suspense fallback={<AgentDetailsSkeleton />}>
      <EditAgentContent params={params} />
    </Suspense>
  );
}

async function EditAgentContent({ params }: Pick<PageProps<"/agents/[agentId]/edit">, "params">) {
  const { agentId } = await params;
  const result = await loadAgent(agentId);
  if ("error" in result) return <LoadError error={result.error} />;
  const { agent } = result;
  const [toolSettings, targets, allAgents] = await Promise.all([
    getAgentToolsForOwner(agent.id),
    getAgentDelegationTargetsForOwner(agent.id),
    listAgentsForOwner(),
  ]);
  return (
    <>
      <BackLink href={`/agents/${agent.id}`}>{agent.name}</BackLink>
      <PageHeader title={`Edit ${agent.name}`} description="Changes are saved when you select Save changes." />
      {/* key: a fresh form, and a fresh "unsaved changes" baseline, whenever
          the saved agent changes (Next.js may keep an older edit page alive). */}
      <AgentForm
        key={`${agent.id}:${agent.updatedAt.toISOString()}`}
        mode="edit"
        agent={agent}
        providers={providerRegistry.list()}
        tools={toolRegistry.catalog()}
        toolSettings={toolSettings}
        workspacePath={displayWorkspacePath(agent.id)}
        delegationOptions={allAgents
          .filter((other) => other.id !== agent.id)
          .map(({ id, name, role, enabled }) => ({ id, name, role, enabled }))}
        delegateTo={targets.map((target) => target.id)}
      />
    </>
  );
}
