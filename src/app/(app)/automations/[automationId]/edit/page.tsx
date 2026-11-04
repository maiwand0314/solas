import type { Metadata } from "next";
import { Suspense } from "react";
import { BackLink } from "@/components/agents/back-link";
import { AutomationForm, AutomationFormSkeleton } from "@/components/automations/automation-form";
import { valuesFromSchedule } from "@/lib/automations/form-values";
import { LoadError } from "@/components/load-error";
import { PageHeader } from "@/components/ui/page-header";
import { timeZoneNames } from "@/lib/automations/schedule";
import { automationAgentOptions } from "../../agent-options";
import { loadAutomation } from "../load-automation";

export const metadata: Metadata = {
  title: "Edit automation",
};

export default function EditAutomationPage({ params }: PageProps<"/automations/[automationId]/edit">) {
  return (
    <Suspense fallback={<AutomationFormSkeleton />}>
      <EditAutomationContent params={params} />
    </Suspense>
  );
}

async function EditAutomationContent({ params }: Pick<PageProps<"/automations/[automationId]/edit">, "params">) {
  const { automationId } = await params;
  const result = await loadAutomation(automationId);
  if ("error" in result) return <LoadError error={result.error} subject="automations" />;
  const { automation } = result.detail;
  const agents = await automationAgentOptions();
  return (
    <>
      <BackLink href={`/automations/${automation.id}`}>{automation.name}</BackLink>
      <PageHeader title={`Edit ${automation.name}`} description="Changes are saved when you select Save changes." />
      {/* key: a fresh form whenever the saved automation changes. */}
      <AutomationForm
        key={`${automation.id}:${automation.updatedAt.toISOString()}`}
        mode="edit"
        agents={agents}
        timeZones={timeZoneNames()}
        automation={{
          id: automation.id,
          name: automation.name,
          description: automation.description,
          agentId: automation.agentId,
          instructions: automation.instructions,
          ...valuesFromSchedule(automation.schedule),
          timeZone: automation.timeZone,
          enabled: automation.enabled,
        }}
      />
    </>
  );
}
