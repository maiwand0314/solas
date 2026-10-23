"use client";

import { useEffect } from "react";
import { THEME_STORAGE_KEY } from "@/lib/preferences";
import { applyTheme, notifyThemeListeners } from "./theme-store";

/**
 * Keeps the theme in sync after the first paint: follows OS changes while the
 * preference is "system", and picks up changes made in other tabs.
 */
export function ThemeWatcher() {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => applyTheme();
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      applyTheme();
      notifyThemeListeners();
    };

    media.addEventListener("change", onSystemChange);
    window.addEventListener("storage", onStorage);
    return () => {
      media.removeEventListener("change", onSystemChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return null;
}
