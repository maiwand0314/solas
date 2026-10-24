"use client";

import { useEffect } from "react";

const MESSAGE = "You have unsaved changes. Leave this page without saving?";

/**
 * While `active`, asks before leaving the page: on reload or closing the tab
 * (the browser's own prompt) and on clicking any in-app link (a confirm
 * dialog). Browser back/forward can't be intercepted reliably and isn't covered.
 */
export function useUnsavedChangesGuard(active: boolean) {
  useEffect(() => {
    if (!active) return;

    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
    }

    // Capture phase on window runs before Next.js <Link> handles the click.
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || link.target === "_blank") return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      if (!window.confirm(MESSAGE)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }

    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("click", onClick, true);
    };
  }, [active]);
}

export function confirmDiscard(): boolean {
  return window.confirm(MESSAGE);
}
