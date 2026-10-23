import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

type InputVariant = "default" | "bare";

const variantClasses: Record<InputVariant, string> = {
  default:
    "h-8 rounded-md border border-border-strong bg-surface px-2.5 shadow-control hover:border-subtle focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25",
  // No chrome of its own, for inputs that sit inside a styled container
  // (e.g. the command menu's search row).
  bare: "bg-transparent",
};

type InputProps = ComponentProps<"input"> & { variant?: InputVariant };

/**
 * Text input with Solas styling. Always give it a visible <label> or, where
 * the context makes the purpose obvious, an `aria-label`.
 */
export function Input({ variant = "default", className, type = "text", ...props }: InputProps) {
  return (
    <input
      type={type}
      className={cn(
        "w-full text-base text-foreground transition-colors duration-100 placeholder:text-subtle focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        variantClasses[variant],
        className,
      )}
      {...props}
    />
  );
}
