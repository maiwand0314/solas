import type { Metadata } from "next";
import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { BackLink } from "@/components/agents/back-link";
import { AutomationForm, AutomationFormSkeleton } from "@/components/automations/automation-form";
import { LoadError } from "@/components/load-error";
import { PageHeader } from "@/components/ui/page-header";
import { timeZoneNames } from "@/lib/automations/schedule";
import { automationAgentOptions } from "../agent-options";

export const metadata: Metadata = {
  title: "New automation",
};

export default function NewAutomationPage() {
  return (
    <>
      <BackLink href="/automations">Automations</BackLink>
      <PageHeader
        title="New automation"
        description="Choose an agent, what it should do, and when. Each run becomes a task in the normal queue."
      />
      <Suspense fallback={<AutomationFormSkeleton />}>
        <NewAutomationForm />
      </Suspense>
    </>
  );
}

async function NewAutomationForm() {
  let agents;
  try {
    agents = await automationAgentOptions();
  } catch (error) {
    unstable_rethrow(error);
    return <LoadError error={error} />;
  }
  return <AutomationForm mode="create" agents={agents} timeZones={timeZoneNames()} />;
}
