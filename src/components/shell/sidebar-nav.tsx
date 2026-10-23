"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { isActivePath, primaryNavItems, secondaryNavItems, type NavItem } from "./nav-items";

/**
 * The navigation list, shared by the desktop sidebar and the mobile drawer.
 * It is a Client Component only because it reads the current URL.
 */
export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className="flex flex-1 flex-col justify-between gap-6 px-2 py-2">
      <NavList items={primaryNavItems} pathname={pathname} />
      <NavList items={secondaryNavItems} pathname={pathname} />
    </nav>
  );
}

function NavList({ items, pathname }: { items: NavItem[]; pathname: string }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((item) => (
        <li key={item.href}>
          <NavLink item={item} active={isActivePath(pathname, item.href)} />
        </li>
      ))}
    </ul>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium transition-colors duration-100",
        "sidebar-collapsed:justify-center sidebar-collapsed:px-0",
        active
          ? "bg-surface-hover text-foreground"
          : "text-muted hover:bg-surface-hover hover:text-foreground",
      )}
    >
      <Icon
        className={cn(
          "size-4 shrink-0",
          active ? "text-foreground" : "text-subtle group-hover:text-muted",
        )}
      />
      {/* Hidden visually when collapsed, but still the link's accessible name. */}
      <span className="truncate sidebar-collapsed:sr-only">{item.label}</span>
      {/* Visual tooltip for the collapsed rail; screen readers use the label above. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-full z-50 ml-2 hidden rounded-md border border-border bg-surface-raised px-2 py-1 text-xs font-medium whitespace-nowrap text-foreground opacity-0 shadow-popover transition-opacity duration-100 group-hover:opacity-100 group-focus-visible:opacity-100 sidebar-collapsed:block"
      >
        {item.label}
      </span>
    </Link>
  );
}
