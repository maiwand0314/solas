import type { Metadata } from "next";
import { Suspense } from "react";
import { AgentForm } from "@/components/agents/agent-form";
import { LoadError } from "@/components/load-error";
import { AgentDetailsSkeleton } from "@/components/agents/agent-skeletons";
import { BackLink } from "@/components/agents/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { providerRegistry } from "@/server/providers/registry";
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
      />
    </>
  );
}
