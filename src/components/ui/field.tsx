import type { ReactNode } from "react";
import { AlertIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

/** IDs a control needs so screen readers announce its hint and error. */
export function fieldAria(id: string, { hint, error }: { hint?: ReactNode; error?: string }) {
  const describedBy = [error && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(" ");
  return {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy || undefined,
  } as const;
}

type FieldProps = {
  /** Must match the control's id; use fieldAria(id, …) on the control. */
  id: string;
  label: string;
  required?: boolean;
  hint?: ReactNode;
  error?: string;
  /** Shown to the right of the label, e.g. a character count. */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
};

/** Label, control, hint, and error, wired together for accessibility. */
export function Field({ id, label, required, hint, error, aside, children, className }: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
          {required ? (
            <span className="ml-0.5 text-muted" aria-hidden="true">
              *
            </span>
          ) : (
            <span className="ml-1.5 text-xs font-normal text-subtle">Optional</span>
          )}
        </label>
        {aside}
      </div>
      {children}
      {error && (
        <p id={`${id}-error`} className="flex items-start gap-1.5 text-sm text-danger">
          <AlertIcon className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </p>
      )}
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}
