import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** A keyboard key hint, e.g. <Kbd>⌘K</Kbd>. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border bg-background px-1 font-mono text-[11px] font-medium text-subtle",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
