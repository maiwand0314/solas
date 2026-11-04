import Link from "next/link";
import { TasksIcon } from "@/components/icons";
import { buttonClassName } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default function TaskNotFound() {
  return (
    <EmptyState icon={TasksIcon} title="Task not found" description="It may have been deleted, together with its agent.">
      <Link href="/tasks" className={buttonClassName()}>
        All tasks
      </Link>
    </EmptyState>
  );
}
