"use client";

import { useEffect, useState, type MouseEvent } from "react";
import { CloseIcon, MenuIcon } from "@/components/icons";
import { ThemeSegmentedControl } from "@/components/preferences/theme-selector";
import { IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SidebarNav } from "./sidebar-nav";
import { Wordmark } from "./wordmark";

/** Menu button and slide-in navigation drawer for small screens (below md). */
export function MobileNav() {
  const [open, setOpen] = useState(false);

  // The drawer is not used at desktop width, so close it if the window grows.
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    const onChange = () => {
      if (desktop.matches) setOpen(false);
    };
    desktop.addEventListener("change", onChange);
    return () => desktop.removeEventListener("change", onChange);
  }, []);

  // Close after following a link, including a link to the current page.
  function closeOnLinkClick(event: MouseEvent<HTMLDialogElement>) {
    if ((event.target as Element).closest("a")) setOpen(false);
  }

  return (
    <div className="md:hidden">
      <IconButton label="Open navigation" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <MenuIcon className="size-4" />
      </IconButton>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        onClick={closeOnLinkClick}
        aria-label="Navigation"
        className="m-0 h-dvh max-h-none w-72 max-w-[calc(100vw-3rem)] border-r border-border bg-surface open:animate-drawer-in"
      >
        <div className="flex h-full flex-col">
          <div className="flex h-12 shrink-0 items-center justify-between pr-2 pl-3">
            <Wordmark />
            <IconButton label="Close navigation" onClick={() => setOpen(false)}>
              <CloseIcon className="size-4" />
            </IconButton>
          </div>
          <SidebarNav />
          <div className="shrink-0 border-t border-border p-3">
            <ThemeSegmentedControl />
          </div>
        </div>
      </Dialog>
    </div>
  );
}
