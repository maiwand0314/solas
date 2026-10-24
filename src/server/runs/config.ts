import "server-only";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Limits for agent runs. One place, so they're easy to find and explain. */
export const RUN_LIMITS = {
  /** A run that takes longer than this is stopped and marked failed. */
  timeoutMs: 3 * 60_000,
  /** Per-run cap on Claude Code's own cost estimate (a safety net, not billing). */
  maxBudgetUsd: 1,
  /** How often the worker looks for new runs when idle. */
  pollIntervalMs: 1_000,
  /** How often a running run checks whether the owner pressed Stop. */
  cancelCheckMs: 1_000,
  /** Earlier messages included as context: at most this many… */
  historyMessages: 20,
  /** …and at most this many characters, dropping the oldest first. */
  historyCharacters: 60_000,
} as const;

/**
 * The directory Claude Code runs in: empty, and outside the repository, so
 * there's no project, no CLAUDE.md, and no source code around it. Created on
 * first use. Refuses a path inside the app's own directory.
 */
export function prepareRuntimeDirectory(appDirectory = process.cwd()): string {
  const directory = path.join(os.tmpdir(), "solas-runtime");
  const relative = path.relative(appDirectory, directory);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    throw new Error(`The runtime directory ${directory} must be outside the app directory.`);
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}
