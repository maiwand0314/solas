import { Skeleton } from "@/components/ui/skeleton";

// Placeholders shaped like the real content, shown while agents load.

export function AgentListSkeleton() {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading agents…</span>
      <div className="mb-3 flex items-center justify-between">
        <Skeleton className="h-8 w-full sm:max-w-xs" />
        <Skeleton className="ml-4 hidden h-4 w-16 sm:block" />
      </div>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-4 px-4 py-4">
            <div className="flex-1">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="mt-2 h-3.5 w-2/3" />
            </div>
            <Skeleton className="hidden h-5 w-40 md:block" />
            <Skeleton className="size-6" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function AgentDetailsSkeleton() {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading agent…</span>
      <Skeleton className="mb-5 h-4 w-20" />
      <div className="mb-8 border-b border-border pb-6">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="mt-2.5 h-4 w-32" />
      </div>
      {[0, 1, 2].map((section) => (
        <div key={section} className="grid gap-4 py-6 lg:grid-cols-[14rem_1fr] lg:gap-10">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-20 w-full" />
        </div>
      ))}
    </div>
  );
}
