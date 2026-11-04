"use client";

import { useSyncExternalStore } from "react";

function subscribeEverySecond(onTick: () => void) {
  const timer = window.setInterval(onTick, 1_000);
  return () => window.clearInterval(timer);
}
const subscribeNever = () => () => {};
// Rounded so repeated reads within a second return the same value.
const currentSecond = () => Math.floor(Date.now() / 1_000) * 1_000;

/**
 * The current time, updated every second while `ticking`, for elapsed times
 * and countdowns. null on the server and during hydration: the server's clock
 * isn't the browser's, and showing two different times would break hydration.
 */
export function useNow(ticking: boolean): number | null {
  return useSyncExternalStore(ticking ? subscribeEverySecond : subscribeNever, currentSecond, () => null);
}
