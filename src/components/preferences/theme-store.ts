// Client-only theme store. Import from Client Components only: it touches
// `window` and uses a React hook.
import { useSyncExternalStore } from "react";
import {
  THEME_STORAGE_KEY,
  isThemePreference,
  resolveTheme,
  type ThemePreference,
} from "@/lib/preferences";

const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();

export function getThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

/** Sets `data-theme` on <html> from a preference and the OS setting. */
export function applyTheme(preference: ThemePreference = getThemePreference()) {
  const root = document.documentElement;
  const theme = resolveTheme(preference, window.matchMedia(SYSTEM_DARK_QUERY).matches);
  if (root.dataset.theme === theme) return;

  // Pause transitions for two frames so every element switches color at once
  // instead of each one animating at its own speed.
  const pause = document.createElement("style");
  pause.textContent = "*,*::before,*::after{transition:none!important}";
  document.head.appendChild(pause);
  root.dataset.theme = theme;
  requestAnimationFrame(() => requestAnimationFrame(() => pause.remove()));
}

export function setThemePreference(preference: ThemePreference) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage can be unavailable (e.g. blocked by the browser). The theme
    // still applies to this page; it just won't be remembered.
  }
  applyTheme(preference);
  notifyThemeListeners();
}

export function notifyThemeListeners() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The stored preference. On the server, and during hydration, it reports
 * "system"; React then re-renders with the real value without a mismatch error.
 */
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, getThemePreference, () => "system");
}
