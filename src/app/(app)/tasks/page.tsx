import type { Metadata } from "next";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { PlusIcon, TasksIcon } from "@/components/icons";
import { LiveRefresh } from "@/components/live-refresh";
import { LoadError } from "@/components/load-error";
import { TaskList, TaskListSkeleton, TaskToolbar, tasksHref } from "@/components/tasks/task-list";
import { buttonClassName } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { parseTaskFilter, TASK_FILTERS } from "@/lib/tasks/status";
import { listTasksForOwner } from "@/server/tasks/queries";
import { listTeamOptionsForOwner } from "@/server/teams/queries";

export const metadata: Metadata = {
  title: "Tasks",
};

function NewTaskButton() {
  return (
    <Link href="/tasks/new" className={buttonClassName({ variant: "primary" })}>
      <PlusIcon className="size-4" />
      New task
    </Link>
  );
}

export default function TasksPage({ searchParams }: PageProps<"/tasks">) {
  return (
    <>
      <PageHeader
        title="Tasks"
        description="Work you hand to an agent. It runs in the background, so you can close Solas and come back to the result."
        actions={<NewTaskButton />}
      />
      {/* The filters come from the URL, which is only known per request: so Suspense. */}
      <Suspense fallback={<TaskListSkeleton />}>
        <StoredTasks searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function StoredTasks({ searchParams }: Pick<PageProps<"/tasks">, "searchParams">) {
  const params = await searchParams;
  const filter = parseTaskFilter(firstValue(params.status));
  const search = (firstValue(params.q) ?? "").trim().slice(0, 200);
  const teamParam = firstValue(params.team);

  let data;
  let team: { id: string; name: string } | undefined;
  try {
    const teams = await listTeamOptionsForOwner();
    team = teams.find((option) => option.id === teamParam);
    data = await listTasksForOwner({ filter, search, teamId: team?.id });
  } catch (error) {
    unstable_rethrow(error);
    return <LoadError error={error} subject="tasks" />;
  }
  const { tasks, counts } = data;

  if (counts.all === 0 && !search && !team) {
    return (
      <EmptyState
        icon={TasksIcon}
        title="No tasks yet"
        description="Give an agent a task with a title and instructions. The worker runs it in the background and saves the result here."
      >
        <NewTaskButton />
      </EmptyState>
    );
  }

  // Keep refreshing while anything (in this search) is queued or running, wherever the filter points.
  const active = counts.queued + counts.running + counts.awaiting_approval > 0;
  const filterLabel = TASK_FILTERS.find((entry) => entry.id === filter)!.label.toLowerCase();

  return (
    <section aria-label="Tasks">
      <LiveRefresh active={active} intervalMs={2_000} />
      {team && (
        <p className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
          Showing tasks given to{" "}
          <Link href={`/teams/${team.id}`} className="font-medium text-foreground underline-offset-2 hover:underline">
            {team.name}
          </Link>
          <Link href={tasksHref(filter, search)} className={buttonClassName({ size: "sm", variant: "ghost" })}>
            Show all tasks
          </Link>
        </p>
      )}
      <TaskToolbar filter={filter} search={search} counts={counts} teamId={team?.id} />
      <p aria-live="polite" className="sr-only">
        {tasks.length} {tasks.length === 1 ? "task" : "tasks"} shown
      </p>
      {tasks.length > 0 ? (
        <TaskList tasks={tasks} />
      ) : (
        <div className="rounded-lg border border-dashed border-border-strong px-6 py-12 text-center">
          <p className="font-medium">
            {search ? `No ${filter === "all" ? "" : `${filterLabel} `}tasks match “${search}”` : `No ${filterLabel} tasks`}
          </p>
          <p className="mt-1 text-sm text-muted">Search looks at titles, instructions, and agent names.</p>
          <Link href={tasksHref("all", "")} className={buttonClassName({ size: "sm", className: "mt-4" })}>
            Show all tasks
          </Link>
        </div>
      )}
    </section>
  );
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
