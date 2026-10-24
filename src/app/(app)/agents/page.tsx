import type { Metadata } from "next";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { AgentList } from "@/components/agents/agent-list";
import { LoadError } from "@/components/load-error";
import { AgentListSkeleton } from "@/components/agents/agent-skeletons";
import { AgentsIcon, PlusIcon } from "@/components/icons";
import { buttonClassName } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { listAgentsForOwner } from "@/server/agents/queries";
import { describeModelSelection, providerRegistry } from "@/server/providers/registry";

export const metadata: Metadata = {
  title: "Agents",
};

function NewAgentButton() {
  return (
    <Link href="/agents/new" className={buttonClassName({ variant: "primary" })}>
      <PlusIcon className="size-4" />
      New agent
    </Link>
  );
}

export default function AgentsPage() {
  return (
    <>
      <PageHeader
        title="Agents"
        description="Agents are assistants you configure with a role, instructions, and a model."
        actions={<NewAgentButton />}
      />
      {/* The header is static; the list is read from the database per request. */}
      <Suspense fallback={<AgentListSkeleton />}>
        <StoredAgents />
      </Suspense>
    </>
  );
}

async function StoredAgents() {
  let agents;
  try {
    agents = await listAgentsForOwner();
  } catch (error) {
    unstable_rethrow(error);
    return <LoadError error={error} />;
  }

  if (agents.length === 0) {
    return (
      <EmptyState
        icon={AgentsIcon}
        title="No agents yet"
        description="Create an agent with a role, instructions, and a model, then chat with it in Conversations."
      >
        <NewAgentButton />
      </EmptyState>
    );
  }

  return (
    <AgentList
      agents={agents.map((agent) => ({ ...agent, modelLabel: describeModelSelection(providerRegistry, agent) }))}
    />
  );
}
