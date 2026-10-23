"use client";

import { useId, type ComponentType } from "react";
import { MonitorIcon, MoonIcon, SunIcon, type IconProps } from "@/components/icons";
import type { ResolvedTheme, ThemePreference } from "@/lib/preferences";
import { setThemePreference, useThemePreference } from "./theme-store";

type ThemeOption = {
  value: ThemePreference;
  label: string;
  icon: ComponentType<IconProps>;
};

const themeOptions: ThemeOption[] = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: MonitorIcon },
];

// Both selectors are native radio groups: the browser provides arrow-key
// navigation, one tab stop, and correct screen reader announcements. The
// inputs are visually hidden and their <label> is styled with `has-checked:`.

/** Compact icon-only control for the sidebar and mobile drawer. */
export function ThemeSegmentedControl() {
  const name = useId();
  const preference = useThemePreference();

  return (
    <fieldset className="flex w-full rounded-md border border-border bg-background p-0.5">
      <legend className="sr-only">Theme</legend>
      {themeOptions.map(({ value, label, icon: Icon }) => (
        <label
          key={value}
          title={label}
          className="flex h-7 flex-1 cursor-pointer items-center justify-center rounded-[5px] text-subtle transition-colors duration-100 hover:text-foreground has-checked:bg-surface has-checked:text-foreground has-checked:shadow-control has-focus-visible:outline-2 has-focus-visible:outline-focus-ring"
        >
          <input
            type="radio"
            name={name}
            value={value}
            checked={preference === value}
            onChange={() => setThemePreference(value)}
            className="sr-only"
          />
          <Icon className="size-3.5" />
          <span className="sr-only">{label}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** Larger cards with a preview of each theme, for the Settings page. */
export function ThemeCards() {
  const name = useId();
  const preference = useThemePreference();

  return (
    <fieldset>
      <legend className="sr-only">Theme</legend>
      <div className="grid gap-3 sm:grid-cols-3">
        {themeOptions.map(({ value, label, icon: Icon }) => (
          <label
            key={value}
            className="cursor-pointer rounded-lg border border-border bg-surface p-2 transition-colors duration-100 hover:border-border-strong has-checked:border-accent has-checked:ring-1 has-checked:ring-accent has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus-ring"
          >
            <input
              type="radio"
              name={name}
              value={value}
              checked={preference === value}
              onChange={() => setThemePreference(value)}
              className="sr-only"
            />
            <ThemePreview preference={value} />
            <span className="mt-2 flex items-center gap-2 px-1 pb-0.5 text-sm font-medium">
              <Icon className="size-4 text-muted" />
              {label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ThemePreview({ preference }: { preference: ThemePreference }) {
  return (
    <span aria-hidden="true" className="flex h-20 overflow-hidden rounded-md border border-border">
      {preference === "system" ? (
        <>
          <PreviewPane theme="light" />
          <PreviewPane theme="dark" />
        </>
      ) : (
        <PreviewPane theme={preference} />
      )}
    </span>
  );
}

/**
 * A miniature app window. Setting data-theme on the pane re-scopes the color
 * tokens to that theme, whatever the page's own theme is.
 */
function PreviewPane({ theme }: { theme: ResolvedTheme }) {
  return (
    <span data-theme={theme} className="flex min-w-0 flex-1 gap-1.5 bg-background p-2">
      <span className="flex w-1/4 flex-col gap-1 rounded-sm border border-border bg-surface p-1">
        <span className="h-1 w-3/4 rounded-full bg-border-strong" />
        <span className="h-1 w-1/2 rounded-full bg-border" />
        <span className="h-1 w-2/3 rounded-full bg-border" />
      </span>
      <span className="flex flex-1 flex-col gap-1.5 p-1">
        <span className="h-1.5 w-2/3 rounded-full bg-foreground/80" />
        <span className="h-1 w-full rounded-full bg-border-strong" />
        <span className="h-1 w-5/6 rounded-full bg-border-strong" />
        <span className="mt-auto h-2.5 w-1/3 rounded-sm bg-accent" />
      </span>
    </span>
  );
}
