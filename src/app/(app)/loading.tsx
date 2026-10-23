import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shown instantly while a page in the shell loads. Next.js wraps each page in
 * a Suspense boundary with this as the fallback. Today's pages are static, so
 * it rarely appears; it matters once pages read from the database.
 * The shapes mirror the real layout (header, then a list) to avoid a jump.
 */
export default function Loading() {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading…</span>

      <div className="mb-8 border-b border-border pb-6">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="mt-2.5 h-4 w-96 max-w-full" />
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        {[0, 1, 2].map((row) => (
          <div
            key={row}
            className="flex items-center justify-between gap-4 border-b border-border px-4 py-4 last:border-b-0"
          >
            <div className="flex-1">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="mt-2 h-3.5 w-2/3" />
            </div>
            <Skeleton className="h-5 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
