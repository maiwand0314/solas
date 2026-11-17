import type { Metadata } from "next";
import { Suspense } from "react";
import { BackLink } from "@/components/agents/back-link";
import { AutomationForm, AutomationFormSkeleton } from "@/components/automations/automation-form";
import { valuesFromSchedule } from "@/lib/automations/form-values";
import { LoadError } from "@/components/load-error";
import { PageHeader } from "@/components/ui/page-header";
import { timeZoneNames } from "@/lib/automations/schedule";
import { automationAgentOptions, automationTeamOptions } from "../../agent-options";
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
  const teams = await automationTeamOptions(agents);
  return (
    <>
      <BackLink href={`/automations/${automation.id}`}>{automation.name}</BackLink>
      <PageHeader title={`Edit ${automation.name}`} description="Changes are saved when you select Save changes." />
      {/* key: a fresh form whenever the saved automation changes. */}
      <AutomationForm
        key={`${automation.id}:${automation.updatedAt.toISOString()}`}
        mode="edit"
        agents={agents}
        teams={teams}
        timeZones={timeZoneNames()}
        automation={{
          id: automation.id,
          name: automation.name,
          description: automation.description,
          targetKind: automation.teamId ? "team" : "agent",
          agentId: automation.agentId ?? "",
          teamId: automation.teamId ?? "",
          maxRunsPerDay: automation.maxRunsPerDay ? String(automation.maxRunsPerDay) : "",
          maxDurationMinutes: automation.maxDurationMs ? String(automation.maxDurationMs / 60_000) : "",
          allowOverlap: automation.allowOverlap,
          pauseAfterFailures: automation.pauseAfterFailures ? String(automation.pauseAfterFailures) : "",
          instructions: automation.instructions,
          ...valuesFromSchedule(automation.schedule),
          timeZone: automation.timeZone,
          enabled: automation.enabled,
        }}
      />
    </>
  );
}
