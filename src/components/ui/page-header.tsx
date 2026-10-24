import type { ReactNode } from "react";

type PageHeaderProps = {
  title: string;
  /** Shown next to the title, e.g. a status badge. */
  badge?: ReactNode;
  description?: ReactNode;
  /** Primary actions for the page, shown on the right. */
  actions?: ReactNode;
};

export function PageHeader({ title, badge, description, actions }: PageHeaderProps) {
  return (
    <header className="mb-8 flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <h1 className="text-xl font-semibold tracking-[-0.015em] break-words">{title}</h1>
          {badge}
        </div>
        {description && <p className="mt-1 max-w-2xl text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
