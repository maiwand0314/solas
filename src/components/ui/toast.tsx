"use client";

import { useSyncExternalStore } from "react";
import { AlertIcon, CheckIcon, CloseIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

// A tiny toast system: a module-level list plus a <Toaster /> that renders it.
// Toasts confirm results ("Agent created") and survive client navigation,
// because the Toaster lives in the app layout, which doesn't re-mount.

type ToastTone = "success" | "error";
type ToastItem = { id: number; tone: ToastTone; message: string };

const DURATION_MS = 5000;
const NO_TOASTS: ToastItem[] = [];

let items: ToastItem[] = NO_TOASTS;
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function show(tone: ToastTone, message: string) {
  const id = nextId++;
  items = [...items, { id, tone, message }].slice(-3);
  emit();
  window.setTimeout(() => dismissToast(id), tone === "error" ? DURATION_MS * 2 : DURATION_MS);
}

export function dismissToast(id: number) {
  items = items.filter((item) => item.id !== id);
  emit();
}

export const toast = {
  success: (message: string) => show("success", message),
  error: (message: string) => show("error", message),
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function Toaster() {
  const toasts = useSyncExternalStore(subscribe, () => items, () => NO_TOASTS);

  return (
    // The live region is always present, so screen readers announce new toasts.
    <div
      aria-live="polite"
      aria-label="Notifications"
      role="region"
      className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-center gap-2 sm:inset-x-auto sm:right-4 sm:items-end"
    >
      {toasts.map((item) => (
        <div
          key={item.id}
          role={item.tone === "error" ? "alert" : "status"}
          className="pointer-events-auto flex w-full max-w-sm animate-dialog-in items-start gap-2.5 rounded-lg border border-border bg-surface-raised py-2.5 pr-2 pl-3 text-sm text-foreground shadow-popover"
        >
          {item.tone === "error" ? (
            <AlertIcon className="mt-px size-4 shrink-0 text-danger" />
          ) : (
            <CheckIcon className="mt-px size-4 shrink-0 text-success" />
          )}
          <p className="min-w-0 flex-1 pt-px">{item.message}</p>
          <button
            type="button"
            onClick={() => dismissToast(item.id)}
            aria-label="Dismiss notification"
            className={cn(
              "-my-0.5 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-subtle hover:bg-surface-hover hover:text-foreground",
            )}
          >
            <CloseIcon className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
