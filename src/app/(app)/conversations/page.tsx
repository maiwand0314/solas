import type { Metadata } from "next";
import { ConversationsIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = {
  title: "Conversations",
};

export default function ConversationsPage() {
  return (
    <>
      <PageHeader
        title="Conversations"
        description="Your chats with agents, saved so you can pick them up again."
      />
      <EmptyState
        icon={ConversationsIcon}
        title="No conversations yet"
        description="Chat isn’t connected to a model yet. Conversations with your agents will appear here once it is."
        status="Not yet available"
      />
    </>
  );
}
