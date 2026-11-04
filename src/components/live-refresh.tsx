"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-renders the page from the database every `intervalMs` while `active`,
 * so a task's status, events, and result appear without a manual reload.
 * The server reads PostgreSQL on each refresh: the database is the only
 * source of truth, and nothing here is guessed in the browser.
 *
 * Paused while the tab is hidden (and refreshed once when it comes back).
 * Closing the tab stops only this polling, never the work itself.
 */
export function LiveRefresh({ active, intervalMs = 1_000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    let timer: number | undefined;
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
      timer = window.setTimeout(tick, intervalMs);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    timer = window.setTimeout(tick, intervalMs);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [active, intervalMs, router]);

  return null;
}
