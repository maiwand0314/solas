"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";
import { findActiveNavItem } from "./nav-items";

type Crumb = { label: string; href?: string };

/** Labels for pages below a section, matched against the rest of the path. */
const SUBPAGE_LABELS: Record<string, { new: string; item: string }> = {
  "/agents": { new: "New agent", item: "Details" },
  "/conversations": { new: "New conversation", item: "Conversation" },
  "/tasks": { new: "New task", item: "Task" },
  "/teams": { new: "New team", item: "Team" },
};

function subpageLabel(section: string, rest: string[]): string | null {
  if (rest.length === 0) return null;
  const labels = SUBPAGE_LABELS[section] ?? { new: "New", item: "Details" };
  if (rest[0] === "new") return labels.new;
  if (rest[1] === "edit") return "Edit";
  return labels.item;
}

function crumbsFor(pathname: string): Crumb[] {
  const section = findActiveNavItem(pathname);
  if (!section) return [{ label: "Not found" }];
  const rest = pathname.slice(section.href.length).split("/").filter(Boolean);
  const sub = subpageLabel(section.href, rest);
  if (!sub) return [{ label: section.label }];
  const crumbs: Crumb[] = [{ label: section.label, href: section.href }];
  // /agents/<id>/edit links back to the agent's details page.
  if (rest[1] === "edit") crumbs.push({ label: "Details", href: `${section.href}/${rest[0]}` });
  crumbs.push({ label: sub });
  return crumbs;
}

/** Where you are, in the top bar: "Solas / Agents / Edit". */
export function Breadcrumbs() {
  return (
    <Suspense fallback={<Trail crumbs={[]} />}>
      <CurrentBreadcrumbs />
    </Suspense>
  );
}

function CurrentBreadcrumbs() {
  return <Trail crumbs={crumbsFor(usePathname())} />;
}

function Trail({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex items-center gap-1.5 text-sm">
        <li className="flex items-center gap-1.5">
          <CrumbLink href="/">Solas</CrumbLink>
        </li>
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <li key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden="true" className="text-border-strong">
                /
              </span>
              {last || !crumb.href ? (
                <span aria-current={last ? "page" : undefined} className="truncate font-medium text-foreground">
                  {crumb.label}
                </span>
              ) : (
                <CrumbLink href={crumb.href}>{crumb.label}</CrumbLink>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function CrumbLink({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href} className="rounded-sm px-0.5 text-muted transition-colors duration-100 hover:text-foreground">
      {children}
    </Link>
  );
}
