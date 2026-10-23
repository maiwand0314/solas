import type { Metadata } from "next";
import { AutomationsIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = {
  title: "Automations",
};

export default function AutomationsPage() {
  return (
    <>
      <PageHeader
        title="Automations"
        description="Recurring work that starts on its own: an agent runs a task on a schedule you set."
      />
      <EmptyState
        icon={AutomationsIcon}
        title="No automations yet"
        description="Schedules aren’t built yet. Automations, their next run, and their history will appear here once they are."
        status="Not yet available"
      />
    </>
  );
}
