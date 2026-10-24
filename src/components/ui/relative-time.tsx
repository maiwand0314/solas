"use client";

import { useSyncExternalStore } from "react";

// "3 minutes ago" depends on the viewer's clock and time zone, which the
// server doesn't know. So the server (and the first client render) show a
// plain UTC date, and the browser swaps in the relative time right after.
// useSyncExternalStore's server snapshot makes that swap hydration-safe.

const TICK_MS = 30_000;

function subscribe(onTick: () => void) {
  const timer = window.setInterval(onTick, TICK_MS);
  return () => window.clearInterval(timer);
}

// Rounded so repeated reads between ticks return the same value.
const getNow = () => Math.floor(Date.now() / TICK_MS) * TICK_MS;

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const shortDate = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const longDate = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });
const fullDateTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

export function formatRelative(date: Date, now: number): string {
  const seconds = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  if (abs < 45 * 60) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 22 * 3600) return relative.format(Math.round(seconds / 3600), "hour");
  if (abs < 6 * 86400) return relative.format(Math.round(seconds / 86400), "day");
  return new Date(now).getFullYear() === date.getFullYear() ? shortDate.format(date) : longDate.format(date);
}

export function RelativeTime({ date }: { date: Date | string }) {
  const now = useSyncExternalStore(subscribe, getNow, () => null);
  const value = new Date(date);
  const iso = value.toISOString();

  return (
    <time dateTime={iso} title={now === null ? undefined : fullDateTime.format(value)}>
      {now === null ? iso.slice(0, 10) : formatRelative(value, now)}
    </time>
  );
}
