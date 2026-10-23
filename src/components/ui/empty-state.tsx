import type { ComponentType, ReactNode } from "react";
import type { IconProps } from "@/components/icons";
import { Badge } from "./badge";

type EmptyStateProps = {
  icon: ComponentType<IconProps>;
  title: string;
  description: ReactNode;
  /** Short status label, e.g. "Not yet available". */
  status?: string;
  /** Optional actions below the text. */
  children?: ReactNode;
};

export function EmptyState({ icon: Icon, title, description, status, children }: EmptyStateProps) {
  return (
    <section className="flex flex-col items-center rounded-lg border border-dashed border-border-strong px-6 py-14 text-center">
      <div className="mb-4 flex size-10 items-center justify-center rounded-lg border border-border bg-surface text-muted shadow-control">
        <Icon className="size-5" />
      </div>
      <h2 className="font-semibold">{title}</h2>
      <p className="mt-1 max-w-sm text-muted">{description}</p>
      {status && (
        <div className="mt-4">
          <Badge>{status}</Badge>
        </div>
      )}
      {children && <div className="mt-5 flex items-center gap-2">{children}</div>}
    </section>
  );
}
