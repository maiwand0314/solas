import type { Metadata } from "next";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { ConversationList, ConversationListSkeleton } from "@/components/conversations/conversation-list";
import { ConversationsIcon, PlusIcon } from "@/components/icons";
import { LoadError } from "@/components/load-error";
import { buttonClassName } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { listConversationsForOwner } from "@/server/conversations/queries";

export const metadata: Metadata = {
  title: "Conversations",
};

function NewConversationButton() {
  return (
    <Link href="/conversations/new" className={buttonClassName({ variant: "primary" })}>
      <PlusIcon className="size-4" />
      New conversation
    </Link>
  );
}

export default function ConversationsPage() {
  return (
    <>
      <PageHeader
        title="Conversations"
        description="Your chats with agents, saved so you can pick them up again."
        actions={<NewConversationButton />}
      />
      <Suspense fallback={<ConversationListSkeleton />}>
        <StoredConversations />
      </Suspense>
    </>
  );
}

async function StoredConversations() {
  let conversations;
  try {
    conversations = await listConversationsForOwner();
  } catch (error) {
    unstable_rethrow(error);
    return <LoadError error={error} subject="conversations" />;
  }

  if (conversations.length === 0) {
    return (
      <EmptyState
        icon={ConversationsIcon}
        title="No conversations yet"
        description="Pick an agent and send it a message. Replies come from Claude, using the agent’s saved instructions."
      >
        <NewConversationButton />
      </EmptyState>
    );
  }
  return <ConversationList conversations={conversations} />;
}
