"use client";

import { useEffect } from "react";
import { SidebarIcon } from "@/components/icons";
import { toggleSidebar, useSidebarCollapsed } from "@/components/preferences/sidebar-store";
import { IconButton } from "@/components/ui/button";
import { isTypingTarget } from "@/lib/keyboard";

/** Collapses the desktop sidebar to an icon rail. Shortcut: [ */
export function SidebarToggle({ className }: { className?: string }) {
  const collapsed = useSidebarCollapsed();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "[" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      toggleSidebar();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <IconButton
      label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      shortcut="["
      aria-expanded={!collapsed}
      aria-controls="desktop-sidebar"
      onClick={toggleSidebar}
      className={className}
    >
      <SidebarIcon className="size-4" />
    </IconButton>
  );
}
