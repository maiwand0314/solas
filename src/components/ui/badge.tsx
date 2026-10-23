import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type BadgeTone = "neutral" | "success";

const dotClasses: Record<BadgeTone, string> = {
  neutral: "bg-subtle",
  success: "bg-success",
};

/** Small status label. The dot adds color, the text carries the meaning. */
export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-sm border border-border bg-surface px-1.5 text-xs font-medium text-muted">
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", dotClasses[tone])} />
      {children}
    </span>
  );
}
