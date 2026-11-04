import type { Metadata } from "next";
import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { AgentForm } from "@/components/agents/agent-form";
import { BackLink } from "@/components/agents/back-link";
import { LoadError } from "@/components/load-error";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { listAgentsForOwner } from "@/server/agents/queries";
import { providerRegistry } from "@/server/providers/registry";
import { toolRegistry } from "@/server/tools/registry";
import { displayWorkspacePath } from "@/server/tools/workspace";

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
      {/* The other agents (delegation targets) are read per request: so Suspense. */}
      <Suspense fallback={<FormSkeleton />}>
        <NewAgentForm />
      </Suspense>
    </>
  );
}

async function NewAgentForm() {
  let others;
  try {
    others = await listAgentsForOwner();
  } catch (error) {
    unstable_rethrow(error);
    return <LoadError error={error} />;
  }
  return (
    <AgentForm
      mode="create"
      providers={providerRegistry.list()}
      tools={toolRegistry.catalog()}
      workspacePath={displayWorkspacePath(null)}
      delegationOptions={others.map(({ id, name, role, enabled }) => ({ id, name, role, enabled }))}
    />
  );
}

function FormSkeleton() {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading…</span>
      {[0, 1, 2].map((section) => (
        <div key={section} className="grid gap-4 py-8 first:pt-0 lg:grid-cols-[14rem_1fr] lg:gap-10">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-24 w-full" />
        </div>
      ))}
    </div>
  );
}
