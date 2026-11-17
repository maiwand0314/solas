import Link from "next/link";
import { Suspense } from "react";
import { buttonClassName } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { getWorkerStatusForOwner } from "@/server/workers/queries";
import { summarizeWorker, type WorkerSummary } from "./worker-status-summary";

const dotClasses: Record<WorkerSummary["tone"], string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  neutral: "bg-subtle",
};

/**
 * The worker's state in the header (M6C): a dot, and on wider screens a word,
 * linking to the details in Settings. Re-read with the page (the bell's
 * LiveRefresh refreshes the route every 15 seconds).
 */
export function WorkerStatusIndicator() {
  return (
    <Suspense fallback={<IndicatorLink summary={null} />}>
      <LiveIndicator />
    </Suspense>
  );
}

async function LiveIndicator() {
  let summary: WorkerSummary | null = null;
  try {
    summary = summarizeWorker(await getWorkerStatusForOwner());
  } catch {
    // Not the owner: the header shows no status rather than breaking the page.
  }
  return <IndicatorLink summary={summary} />;
}

function IndicatorLink({ summary }: { summary: WorkerSummary | null }) {
  const label = summary ? `Worker: ${summary.label}` : "Worker status";
  return (
    <Link
      href="/settings#worker"
      aria-label={label}
      title={label}
      className={buttonClassName({ variant: "ghost", size: "md", className: "min-w-8 justify-center gap-2 px-2" })}
    >
      <span aria-hidden="true" className={cn("size-2 rounded-full", summary ? dotClasses[summary.tone] : "bg-surface-hover")} />
      <span aria-hidden="true" className="hidden text-xs sm:inline">
        {summary ? `Worker ${summary.label.toLowerCase()}` : "Worker"}
      </span>
    </Link>
  );
}
