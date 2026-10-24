import type { Metadata } from "next";
import Link from "next/link";
import { notFound, unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { BackLink } from "@/components/agents/back-link";
import { AgentPicker } from "@/components/conversations/agent-picker";
import { ConversationSkeleton } from "@/components/conversations/conversation-list";
import { ConversationView } from "@/components/conversations/conversation-view";
import { AgentsIcon } from "@/components/icons";
import { LoadError } from "@/components/load-error";
import { buttonClassName } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { AgentServiceError } from "@/server/agents/errors";
import { getAgentForOwner, listAgentsForOwner } from "@/server/agents/queries";
import { chatUnavailableReason } from "@/server/conversations/queries";
import { describeModelSelection, providerRegistry } from "@/server/providers/registry";

export const metadata: Metadata = {
  title: "New conversation",
};

// /conversations/new           → choose an agent
// /conversations/new?agent=<id> → an empty chat with that agent; the first
//                                  message creates the conversation.
export default function NewConversationPage({ searchParams }: PageProps<"/conversations/new">) {
  return (
    <>
      <BackLink href="/conversations">Conversations</BackLink>
      {/* searchParams are only known per request: so Suspense. */}
      <Suspense fallback={<ConversationSkeleton />}>
        <NewConversation searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function NewConversation({ searchParams }: Pick<PageProps<"/conversations/new">, "searchParams">) {
  const { agent: agentParam } = await searchParams;
  const agentId = typeof agentParam === "string" ? agentParam : undefined;
  return agentId ? <ChatWithAgent agentId={agentId} /> : <ChooseAgent />;
}

async function ChatWithAgent({ agentId }: { agentId: string }) {
  let agent;
  try {
    agent = await getAgentForOwner(agentId);
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof AgentServiceError && (error.code === "not_found" || error.code === "validation_failed")) {
      notFound();
    }
    return <LoadError error={error} />;
  }
  const modelLabel = describeModelSelection(providerRegistry, agent);
  return (
    <>
      <PageHeader title={agent.name} description={[agent.role, modelLabel].filter(Boolean).join(" · ")} />
      <ConversationView
        agent={{ id: agent.id, name: agent.name, modelLabel, unavailableReason: chatUnavailableReason(agent) }}
        conversationId={null}
        messages={[]}
        runs={[]}
      />
    </>
  );
}

async function ChooseAgent() {
  let agents;
  try {
    agents = await listAgentsForOwner();
  } catch (error) {
    unstable_rethrow(error);
    return <LoadError error={error} />;
  }
  return (
    <>
      <PageHeader title="New conversation" description="Choose the agent you want to talk to." />
      {agents.length === 0 ? (
        <EmptyState icon={AgentsIcon} title="No agents yet" description="Create an agent first, then chat with it here.">
          <Link href="/agents/new" className={buttonClassName({ variant: "primary" })}>
            New agent
          </Link>
        </EmptyState>
      ) : (
        <AgentPicker
          agents={agents.map((agent) => ({
            id: agent.id,
            name: agent.name,
            role: agent.role,
            modelLabel: describeModelSelection(providerRegistry, agent),
            unavailableReason: chatUnavailableReason(agent),
          }))}
        />
      )}
    </>
  );
}
