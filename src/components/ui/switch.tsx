import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

type SwitchProps = Omit<ComponentProps<"button">, "onChange" | "role" | "aria-checked"> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
};

/**
 * An on/off control (ARIA "switch" pattern): a button that announces its state
 * as checked / not checked. Give it a label via aria-label or aria-labelledby.
 */
export function Switch({ checked, onCheckedChange, className, disabled, ...props }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "border-accent bg-accent" : "border-border-strong bg-surface-hover",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-block size-3.5 rounded-full shadow-control transition-transform duration-150 ease-standard",
          checked ? "translate-x-[18px] bg-accent-foreground" : "translate-x-[2px] bg-surface",
        )}
      />
    </button>
  );
}
