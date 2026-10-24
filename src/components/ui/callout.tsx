import type { ReactNode } from "react";
import { AlertIcon, InfoIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

type CalloutTone = "info" | "danger";

const toneClasses: Record<CalloutTone, string> = {
  info: "border-border bg-surface text-muted",
  danger: "border-danger/35 bg-danger/[0.06] text-foreground",
};

type CalloutProps = {
  tone?: CalloutTone;
  title?: string;
  children?: ReactNode;
  /** Buttons or links shown below the text. */
  actions?: ReactNode;
  /** Use "alert" for errors that appear after an action. */
  role?: "alert" | "status";
  className?: string;
};

/** An inline notice: an honest limitation, or an error with a way forward. */
export function Callout({ tone = "info", title, children, actions, role, className }: CalloutProps) {
  const Icon = tone === "danger" ? AlertIcon : InfoIcon;
  return (
    <div role={role} className={cn("flex gap-3 rounded-lg border px-4 py-3.5", toneClasses[tone], className)}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", tone === "danger" ? "text-danger" : "text-subtle")} />
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium text-foreground">{title}</p>}
        {children && <div className={cn("text-sm", title && "mt-0.5", tone === "info" && "text-muted")}>{children}</div>}
        {actions && <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
