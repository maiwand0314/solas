import type { Metadata } from "next";
import Link from "next/link";
import { notFound, unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { BackLink } from "@/components/agents/back-link";
import { ConversationSkeleton } from "@/components/conversations/conversation-list";
import { ConversationView } from "@/components/conversations/conversation-view";
import { LoadError } from "@/components/load-error";
import { buttonClassName } from "@/components/ui/button";
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
      <BackLink href="/conversations">Conversations</BackLink>
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
          <Link href={`/agents/${agent.id}`} className={buttonClassName({ variant: "secondary" })}>
            Agent
          </Link>
        }
      />
      <ConversationView
        agent={{ id: agent.id, name: agent.name, modelLabel, unavailableReason: chatUnavailableReason(agent) }}
        conversationId={conversation.id}
        messages={messages.map(({ id, role, content }) => ({ id, role, content }))}
        runs={runs}
      />
    </>
  );
}
