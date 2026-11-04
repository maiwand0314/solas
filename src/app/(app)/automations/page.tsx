import type { Metadata } from "next";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { AgentListSkeleton } from "@/components/agents/agent-skeletons";
import { AutomationList } from "@/components/automations/automation-list";
import { AutomationsIcon, PlusIcon } from "@/components/icons";
import { LoadError } from "@/components/load-error";
import { buttonClassName } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { listAutomationsForOwner } from "@/server/automations/queries";

export const metadata: Metadata = {
  title: "Automations",
};

function NewAutomationButton() {
  return (
    <Link href="/automations/new" className={buttonClassName({ variant: "primary" })}>
      <PlusIcon className="size-4" />
      New automation
    </Link>
  );
}

export default function AutomationsPage() {
  return (
    <>
      <PageHeader
        title="Automations"
        description="Recurring work that starts on its own: an agent runs a task on a schedule you set."
        actions={<NewAutomationButton />}
      />
      <Suspense fallback={<AgentListSkeleton />}>
        <StoredAutomations />
      </Suspense>
    </>
  );
}

async function StoredAutomations() {
  let automations;
  try {
    automations = await listAutomationsForOwner();
  } catch (error) {
    unstable_rethrow(error);
    return <LoadError error={error} subject="automations" />;
  }
  if (automations.length === 0) {
    return (
      <EmptyState
        icon={AutomationsIcon}
        title="No automations yet"
        description="Choose an agent, the task it should do, and when: once, every few hours, or every day, week, or month. Each run becomes a task you can follow."
      >
        <NewAutomationButton />
      </EmptyState>
    );
  }
  return <AutomationList automations={automations} />;
}
