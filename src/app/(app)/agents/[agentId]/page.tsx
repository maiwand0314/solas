import type { Metadata } from "next";
import { Suspense } from "react";
import { AgentDetails } from "@/components/agents/agent-details";
import { AgentLoadError } from "@/components/agents/agent-load-error";
import { AgentDetailsSkeleton } from "@/components/agents/agent-skeletons";
import { describeModelSelection, providerRegistry } from "@/server/providers/registry";
import { loadAgent } from "./load-agent";

export const metadata: Metadata = {
  title: "Agent",
};

export default function AgentPage({ params }: PageProps<"/agents/[agentId]">) {
  // The id comes from the URL, which is only known per request: so Suspense.
  return (
    <Suspense fallback={<AgentDetailsSkeleton />}>
      <AgentPageContent params={params} />
    </Suspense>
  );
}

async function AgentPageContent({ params }: Pick<PageProps<"/agents/[agentId]">, "params">) {
  const { agentId } = await params;
  const result = await loadAgent(agentId);
  if ("error" in result) return <AgentLoadError error={result.error} />;
  return (
    <AgentDetails agent={result.agent} modelLabel={describeModelSelection(providerRegistry, result.agent)} />
  );
}
