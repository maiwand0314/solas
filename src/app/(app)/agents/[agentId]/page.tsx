import type { Metadata } from "next";
import { Suspense } from "react";
import { AgentDetails } from "@/components/agents/agent-details";
import { LoadError } from "@/components/load-error";
import { AgentDetailsSkeleton } from "@/components/agents/agent-skeletons";
import { getAgentToolsForOwner } from "@/server/agents/queries";
import { describeModelSelection, providerRegistry } from "@/server/providers/registry";
import { toolRegistry } from "@/server/tools/registry";
import { displayWorkspacePath } from "@/server/tools/workspace";
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
  if ("error" in result) return <LoadError error={result.error} />;
  const settings = await getAgentToolsForOwner(result.agent.id);
  const tools = settings.map((setting) => ({ ...toolRegistry.get(setting.toolId)!, mode: setting.mode }));
  return (
    <AgentDetails
      agent={result.agent}
      modelLabel={describeModelSelection(providerRegistry, result.agent)}
      tools={tools.map(({ id, name, risk, approval, capability, mode }) => ({ id, name, risk, approval, capability, mode }))}
      workspacePath={displayWorkspacePath(result.agent.id)}
    />
  );
}
