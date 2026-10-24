import type { Metadata } from "next";
import { notFound, unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { BackLink } from "@/components/agents/back-link";
import { ConversationSkeleton } from "@/components/conversations/conversation-list";
import { ConversationActions } from "@/components/conversations/conversation-actions";
import { ConversationView } from "@/components/conversations/conversation-view";
import { LoadError } from "@/components/load-error";
import { PageHeader } from "@/components/ui/page-header";
import { ConversationServiceError } from "@/server/conversations/errors";
import { chatUnavailableReason, getConversationForOwner } from "@/server/conversations/queries";
import { describeModelSelection, providerRegistry } from "@/server/providers/registry";

export const metadata: Metadata = {
  title: "Conversation",
};

export default function ConversationPage({ params }: PageProps<"/conversations/[conversationId]">) {
  return (
    <>
      {/* On wide screens the list is beside the page, so no back link. */}
      <div className="lg:hidden">
        <BackLink href="/conversations">Conversations</BackLink>
      </div>
      <Suspense fallback={<ConversationSkeleton />}>
        <ConversationContent params={params} />
      </Suspense>
    </>
  );
}

async function ConversationContent({ params }: Pick<PageProps<"/conversations/[conversationId]">, "params">) {
  const { conversationId } = await params;
  let thread;
  try {
    thread = await getConversationForOwner(conversationId);
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ConversationServiceError && (error.code === "not_found" || error.code === "validation_failed")) {
      notFound();
    }
    return <LoadError error={error} subject="conversations" />;
  }

  const { conversation, agent, messages, runs } = thread;
  const modelLabel = describeModelSelection(providerRegistry, agent);
  return (
    <>
      <PageHeader
        title={conversation.title}
        description={[agent.name, modelLabel].filter(Boolean).join(" · ")}
        actions={
          <ConversationActions
            conversation={{ id: conversation.id, title: conversation.title, agentId: agent.id }}
          />
        }
      />
      <ConversationView
        agent={{ id: agent.id, name: agent.name, modelLabel, unavailableReason: chatUnavailableReason(agent) }}
        conversationId={conversation.id}
        messages={messages.map(({ id, role, content, createdAt, runId, clientMessageId }) => ({
          id,
          role,
          content,
          createdAt,
          runId,
          clientMessageId,
        }))}
        runs={runs}
      />
    </>
  );
}
