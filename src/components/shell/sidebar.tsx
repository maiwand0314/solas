import { ThemeSegmentedControl } from "@/components/preferences/theme-selector";
import { SidebarNav } from "./sidebar-nav";
import { Wordmark } from "./wordmark";

/**
 * Desktop sidebar (md and up). A Server Component that composes small Client
 * Components. Its collapsed width is pure CSS, driven by `data-sidebar` on
 * <html>, so it is correct from the very first paint. The toggle lives in the
 * top bar, where it stays in the same place in both states.
 */
export function Sidebar() {
  return (
    <aside
      id="desktop-sidebar"
      data-desktop-sidebar
      className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-border bg-surface md:flex sidebar-collapsed:w-14"
    >
      <div className="flex h-12 shrink-0 items-center px-3 sidebar-collapsed:justify-center sidebar-collapsed:px-0">
        <Wordmark className="sidebar-collapsed:hidden" />
        <Wordmark monogram className="hidden sidebar-collapsed:inline-flex" />
      </div>
      <SidebarNav />
      <div className="shrink-0 border-t border-border p-3 sidebar-collapsed:hidden">
        <ThemeSegmentedControl />
      </div>
    </aside>
  );
}
