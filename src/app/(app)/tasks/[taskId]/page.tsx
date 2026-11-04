import type { Metadata } from "next";
import { notFound, unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { BackLink } from "@/components/agents/back-link";
import { LoadError } from "@/components/load-error";
import { TaskDetail } from "@/components/tasks/task-detail";
import { Skeleton } from "@/components/ui/skeleton";
import { getTaskForOwner } from "@/server/tasks/queries";
import { TaskServiceError } from "@/server/tasks/errors";
import { toolDisplayInfo } from "@/server/tools/registry";

export const metadata: Metadata = {
  title: "Task",
};

export default function TaskPage({ params }: PageProps<"/tasks/[taskId]">) {
  return (
    <>
      <BackLink href="/tasks">Tasks</BackLink>
      <Suspense fallback={<TaskSkeleton />}>
        <TaskContent params={params} />
      </Suspense>
    </>
  );
}

async function TaskContent({ params }: Pick<PageProps<"/tasks/[taskId]">, "params">) {
  const { taskId } = await params;
  let detail;
  try {
    detail = await getTaskForOwner(taskId);
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof TaskServiceError && (error.code === "not_found" || error.code === "validation_failed")) {
      notFound();
    }
    return <LoadError error={error} subject="tasks" />;
  }
  return <TaskDetail detail={detail} toolInfo={toolDisplayInfo()} />;
}

function TaskSkeleton() {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading task…</span>
      <div className="mb-8 border-b border-border pb-6">
        <Skeleton className="h-6 w-72" />
        <Skeleton className="mt-2.5 h-4 w-48" />
      </div>
      {[0, 1, 2].map((section) => (
        <div key={section} className="grid gap-4 py-6 lg:grid-cols-[12rem_1fr] lg:gap-10">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-24 w-full" />
        </div>
      ))}
    </div>
  );
}
