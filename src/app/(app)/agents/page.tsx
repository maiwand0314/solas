import type { Metadata } from "next";
import { AgentsIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = {
  title: "Agents",
};

export default function AgentsPage() {
  return (
    <>
      <PageHeader
        title="Agents"
        description="Agents are assistants you configure with their own instructions, model, and tools."
      />
      <EmptyState
        icon={AgentsIcon}
        title="No agents yet"
        description="Creating and editing agents isn’t built yet. Your agents will be listed here once it is."
        status="Not yet available"
      />
    </>
  );
}
