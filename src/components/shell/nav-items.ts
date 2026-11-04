import type { ComponentType } from "react";
import {
  AgentsIcon,
  AutomationsIcon,
  ConversationsIcon,
  OverviewIcon,
  SettingsIcon,
  TasksIcon,
  TeamsIcon,
  type IconProps,
} from "@/components/icons";

export type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<IconProps>;
};

export const primaryNavItems: NavItem[] = [
  { href: "/", label: "Overview", icon: OverviewIcon },
  { href: "/agents", label: "Agents", icon: AgentsIcon },
  { href: "/teams", label: "Teams", icon: TeamsIcon },
  { href: "/conversations", label: "Conversations", icon: ConversationsIcon },
  { href: "/tasks", label: "Tasks", icon: TasksIcon },
  { href: "/automations", label: "Automations", icon: AutomationsIcon },
];

export const secondaryNavItems: NavItem[] = [
  { href: "/settings", label: "Settings", icon: SettingsIcon },
];

export const allNavItems: NavItem[] = [...primaryNavItems, ...secondaryNavItems];

/** "/" only matches itself; other items also match their sub-pages. */
export function isActivePath(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function findActiveNavItem(pathname: string): NavItem | undefined {
  return allNavItems.find((item) => isActivePath(pathname, item.href));
}
