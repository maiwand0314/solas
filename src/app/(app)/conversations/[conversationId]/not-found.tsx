import Link from "next/link";
import { ConversationsIcon } from "@/components/icons";
import { buttonClassName } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default function ConversationNotFound() {
  return (
    <EmptyState
      icon={ConversationsIcon}
      title="Conversation not found"
      description="It may have been deleted, together with its agent."
    >
      <Link href="/conversations" className={buttonClassName()}>
        All conversations
      </Link>
    </EmptyState>
  );
}
