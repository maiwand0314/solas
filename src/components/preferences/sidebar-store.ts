// Client-only sidebar store. The source of truth is the `data-sidebar`
// attribute on <html>, which CSS reads directly (see globals.css).
import { useSyncExternalStore } from "react";
import { SIDEBAR_STORAGE_KEY } from "@/lib/preferences";

const listeners = new Set<() => void>();

function isSidebarCollapsed() {
  return document.documentElement.dataset.sidebar === "collapsed";
}

export function toggleSidebar() {
  const collapsed = !isSidebarCollapsed();
  const root = document.documentElement;
  if (collapsed) root.dataset.sidebar = "collapsed";
  else delete root.dataset.sidebar;

  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? "collapsed" : "expanded");
  } catch {
    // Not remembered if storage is unavailable; the toggle still works.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(subscribe, isSidebarCollapsed, () => false);
}
