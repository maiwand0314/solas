"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { findActiveNavItem } from "./nav-items";

/**
 * Where you are, in the top bar. Today every page is one level deep, so this
 * is "Solas / Section"; deeper pages (an agent, a conversation) will add to it.
 */
export function Breadcrumbs() {
  const pathname = usePathname();
  const current = findActiveNavItem(pathname);

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex items-center gap-1.5 text-sm">
        <li className="flex items-center gap-1.5">
          <Link href="/" className="rounded-sm px-0.5 text-muted transition-colors duration-100 hover:text-foreground">
            Solas
          </Link>
          <span aria-hidden="true" className="text-border-strong">
            /
          </span>
        </li>
        <li aria-current="page" className="truncate font-medium text-foreground">
          {current?.label ?? "Not found"}
        </li>
      </ol>
    </nav>
  );
}
