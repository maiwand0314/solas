import { cn } from "@/lib/cn";

/**
 * Placeholder shape for content that is loading. Purely visual: the region
 * that contains skeletons should carry `aria-busy` and a text label.
 * The pulse stops under prefers-reduced-motion (see globals.css).
 */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-surface-hover", className)} />;
}
