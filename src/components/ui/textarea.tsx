import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/** Multi-line text input, styled to match Input. Grows vertically by dragging. */
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "block w-full resize-y rounded-md border border-border-strong bg-surface px-2.5 py-2 text-base text-foreground shadow-control transition-colors duration-100 placeholder:text-subtle hover:border-subtle focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger aria-invalid:focus-visible:ring-danger/25",
        className,
      )}
      {...props}
    />
  );
}
