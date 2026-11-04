import Form from "next/form";
import Link from "next/link";
import { SearchIcon } from "@/components/icons";
import { Input } from "@/components/ui/input";
import { RelativeTime } from "@/components/ui/relative-time";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { TASK_FILTERS, type TaskFilterId } from "@/lib/tasks/status";
import type { TaskSummary } from "@/server/tasks/service";
import { TaskActions } from "./task-actions";
import { TaskStatusBadge } from "./task-status-badge";

/** The Tasks URL for a filter and search, leaving out defaults. */
export function tasksHref(filter: TaskFilterId, search: string): string {
  const params = new URLSearchParams();
  if (filter !== "all") params.set("status", filter);
  if (search) params.set("q", search);
  const query = params.toString();
  return query ? `/tasks?${query}` : "/tasks";
}

/**
 * Search and status filters. Both live in the URL, so a filtered list can be
 * reloaded, shared between tabs, and used without JavaScript. Counts are real
 * counts for the current search.
 */
export function TaskToolbar({
  filter,
  search,
  counts,
}: {
  filter: TaskFilterId;
  search: string;
  counts: Record<TaskFilterId, number>;
}) {
  return (
    <div className="mb-4 flex flex-col gap-3">
      <Form action="/tasks" role="search" className="relative w-full sm:max-w-xs">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle" />
        {/* Keyed by the search, so the field shows the URL's value after navigating. */}
        <Input
          key={search}
          type="search"
          name="q"
          defaultValue={search}
          aria-label="Search tasks"
          placeholder="Search tasks"
          maxLength={200}
          className="pl-8"
        />
        {filter !== "all" && <input type="hidden" name="status" value={filter} />}
      </Form>
      <nav aria-label="Filter tasks by status">
        <ul className="flex flex-wrap gap-1">
          {TASK_FILTERS.map((entry) => {
            const current = entry.id === filter;
            return (
              <li key={entry.id}>
                <Link
                  href={tasksHref(entry.id, search)}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors duration-100",
                    current
                      ? "bg-surface-hover font-medium text-foreground"
                      : "text-muted hover:bg-surface-hover/60 hover:text-foreground",
                  )}
                >
                  {entry.label}
                  <span className="text-xs text-subtle tabular-nums">{counts[entry.id]}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

/** The task rows. Each row opens the task; Cancel or Retry sits on the right when it applies. */
export function TaskList({ tasks }: { tasks: TaskSummary[] }) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
      {tasks.map((task) => {
        const cancelling = task.cancelRequestedAt !== null;
        const times = (
          <>
            <span className="whitespace-nowrap tabular-nums">
              Created <RelativeTime date={task.createdAt} />
            </span>
            <span className="whitespace-nowrap tabular-nums">
              Updated <RelativeTime date={task.updatedAt} />
            </span>
          </>
        );
        return (
          <li
            key={task.id}
            className="relative flex items-start gap-3 px-4 py-3.5 transition-colors duration-100 hover:bg-surface-hover/60"
          >
            <div className="min-w-0 flex-1">
              {/* The ::after overlay makes the whole row clickable; the action button sits above it. */}
              <Link
                href={`/tasks/${task.id}`}
                className="block truncate font-medium text-foreground after:absolute after:inset-0 after:content-['']"
              >
                {task.title}
              </Link>
              <p className="mt-0.5 truncate text-sm text-muted">
                {task.agentName}
                {task.delegatedBy && <span className="text-subtle"> · delegated by {task.delegatedBy}</span>}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-subtle md:hidden">
                <TaskStatusBadge status={task.status} cancelling={cancelling} />
                {times}
              </div>
            </div>
            <div className="hidden shrink-0 items-center gap-4 self-center text-xs text-subtle md:flex">
              <TaskStatusBadge status={task.status} cancelling={cancelling} />
              {times}
            </div>
            <div className="relative z-10 shrink-0 self-center">
              <TaskActions taskId={task.id} title={task.title} status={task.status} cancelling={cancelling} size="sm" />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function TaskListSkeleton() {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading tasks…</span>
      <Skeleton className="mb-3 h-8 w-full sm:max-w-xs" />
      <div className="mb-4 flex gap-2">
        {[0, 1, 2, 3].map((item) => (
          <Skeleton key={item} className="h-7 w-20" />
        ))}
      </div>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-4 px-4 py-4">
            <div className="flex-1">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="mt-2 h-3.5 w-1/5" />
            </div>
            <Skeleton className="hidden h-5 w-56 md:block" />
          </div>
        ))}
      </div>
    </div>
  );
}
