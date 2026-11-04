import type { Metadata } from "next";
import { Suspense } from "react";
import { AgentDetailsSkeleton } from "@/components/agents/agent-skeletons";
import { BackLink } from "@/components/agents/back-link";
import { AutomationDetail } from "@/components/automations/automation-detail";
import { LoadError } from "@/components/load-error";
import { loadAutomation } from "./load-automation";

export const metadata: Metadata = {
  title: "Automation",
};

export default function AutomationPage({ params }: PageProps<"/automations/[automationId]">) {
  return (
    <>
      <BackLink href="/automations">Automations</BackLink>
      <Suspense fallback={<AgentDetailsSkeleton />}>
        <AutomationContent params={params} />
      </Suspense>
    </>
  );
}

async function AutomationContent({ params }: Pick<PageProps<"/automations/[automationId]">, "params">) {
  const { automationId } = await params;
  const result = await loadAutomation(automationId);
  if ("error" in result) return <LoadError error={result.error} subject="automations" />;
  return <AutomationDetail detail={result.detail} />;
}
