import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

type ButtonVariant = "primary" | "secondary" | "ghost";
type ButtonSize = "sm" | "md" | "icon";

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-foreground shadow-control hover:bg-accent/90",
  secondary:
    "border border-border-strong bg-surface text-foreground shadow-control hover:bg-surface-hover",
  ghost: "text-muted hover:bg-surface-hover hover:text-foreground",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-sm",
  md: "h-8 px-3 text-sm",
  icon: "size-8",
};

type ButtonStyleOptions = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
};

/**
 * Button classes on their own, so links can look like buttons:
 * <Link className={buttonClassName({ variant: "secondary" })} />
 */
export function buttonClassName({
  variant = "secondary",
  size = "md",
  className,
}: ButtonStyleOptions = {}) {
  return cn(
    "inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors duration-100 disabled:pointer-events-none disabled:opacity-50",
    variantClasses[variant],
    sizeClasses[size],
    className,
  );
}

type ButtonProps = ComponentProps<"button"> & Omit<ButtonStyleOptions, "className">;

export function Button({ variant, size, className, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={buttonClassName({ variant, size, className })} {...props} />;
}

type IconButtonProps = Omit<ComponentProps<"button">, "aria-label"> & {
  /** Accessible name; also shown as a native tooltip. */
  label: string;
  /** Keyboard shortcut, announced via aria-keyshortcuts and shown in the tooltip. */
  shortcut?: string;
};

/** Square ghost button for a single icon. The label is required. */
export function IconButton({ label, shortcut, className, type = "button", ...props }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      aria-keyshortcuts={shortcut}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={buttonClassName({ variant: "ghost", size: "icon", className })}
      {...props}
    />
  );
}
