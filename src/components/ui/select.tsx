import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/** Native select, styled to match Input. Native keeps keyboard and mobile pickers right. */
export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <div className="relative">
      <select
        className={cn(
          "h-8 w-full cursor-pointer appearance-none rounded-md border border-border-strong bg-surface pr-8 pl-2.5 text-base text-foreground shadow-control transition-colors duration-100 hover:border-subtle focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-subtle"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m7 10 5 5 5-5" />
      </svg>
    </div>
  );
}
