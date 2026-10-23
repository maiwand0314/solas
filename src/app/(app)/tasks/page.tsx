import type { Metadata } from "next";
import { TasksIcon } from "@/components/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = {
  title: "Tasks",
};

export default function TasksPage() {
  return (
    <>
      <PageHeader
        title="Tasks"
        description="One-off pieces of work you hand to an agent, then come back to review."
      />
      <EmptyState
        icon={TasksIcon}
        title="No tasks yet"
        description="Assigning tasks isn’t built yet. Each task’s status, result, and run history will appear here once it is."
        status="Not yet available"
      />
    </>
  );
}
