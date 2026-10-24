import Link from "next/link";
import { AgentsIcon } from "@/components/icons";
import { buttonClassName } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default function AgentNotFound() {
  return (
    <EmptyState
      icon={AgentsIcon}
      title="Agent not found"
      description="This agent doesn’t exist. It may have been deleted, or the link is wrong."
    >
      <Link href="/agents" className={buttonClassName()}>
        Back to agents
      </Link>
    </EmptyState>
  );
}
