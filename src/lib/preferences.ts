// Browser preferences shared by the server-rendered inline script and the
// client-side stores, so both agree on storage keys and values.

export const THEME_STORAGE_KEY = "solas:theme";
export const SIDEBAR_STORAGE_KEY = "solas:sidebar";

export const THEME_PREFERENCES = ["light", "dark", "system"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = "light" | "dark";

export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference);
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

/**
 * Runs in <head> before the first paint so the page never flashes the wrong
 * theme or sidebar width. It is inlined into the HTML as a string and is not
 * processed by the bundler, so it is kept small and in plain ES5.
 */
export const preferencesScript = `(function(){
var d=document.documentElement,t=null,s=null;
try{t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});s=localStorage.getItem(${JSON.stringify(SIDEBAR_STORAGE_KEY)})}catch(e){}
if(t!=="light"&&t!=="dark")t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";
d.setAttribute("data-theme",t);
if(s==="collapsed")d.setAttribute("data-sidebar","collapsed");
})()`;
