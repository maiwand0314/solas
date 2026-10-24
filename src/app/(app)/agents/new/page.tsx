import type { Metadata } from "next";
import { AgentForm } from "@/components/agents/agent-form";
import { BackLink } from "@/components/agents/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { providerRegistry } from "@/server/providers/registry";

export const metadata: Metadata = {
  title: "New agent",
};

export default function NewAgentPage() {
  return (
    <>
      <BackLink href="/agents">Agents</BackLink>
      <PageHeader
        title="New agent"
        description="Give the agent a clear role and instructions. You can change everything later."
      />
      <AgentForm mode="create" providers={providerRegistry.list()} />
    </>
  );
}
