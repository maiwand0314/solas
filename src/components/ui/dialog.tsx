"use client";

import { useEffect, useLayoutEffect, useRef, type ComponentProps, type MouseEvent } from "react";
import { cn } from "@/lib/cn";

type DialogProps = Omit<ComponentProps<"dialog">, "open" | "onClose"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * A modal built on the native <dialog> element. showModal() gives us, for
 * free: focus moves into the dialog, the rest of the page becomes inert,
 * Escape closes it, and focus returns to the element that opened it.
 *
 * Give it an accessible name with `aria-label` or `aria-labelledby`, and a
 * background, size, and position via `className`.
 */
export function Dialog({ open, onOpenChange, className, onClick, children, ...props }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  // React state is the source of truth; keep the element in sync with it.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Close when the page is hidden (Next.js keeps visited pages mounted), so
  // a modal never comes back open, or keeps the rest of the page inert.
  useLayoutEffect(() => {
    const dialog = ref.current;
    return () => dialog?.close();
  }, []);

  function handleClick(event: MouseEvent<HTMLDialogElement>) {
    onClick?.(event);
    // A click on the <dialog> element itself (not its content) is a backdrop click.
    if (event.target === event.currentTarget) onOpenChange(false);
  }

  return (
    <dialog
      ref={ref}
      // Fires for Escape and for dialog.close(), so state never drifts.
      onClose={() => onOpenChange(false)}
      onClick={handleClick}
      className={cn(
        "p-0 text-foreground backdrop:bg-black/40 dark:backdrop:bg-black/60",
        className,
      )}
      {...props}
    >
      {children}
    </dialog>
  );
}
