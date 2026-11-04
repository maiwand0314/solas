import "server-only";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Limits for agent runs. One place, so they're easy to find and explain. */
export const RUN_LIMITS = {
  /** A conversation reply that takes longer than this is stopped and marked failed. */
  timeoutMs: 3 * 60_000,
  /** The same for one attempt at a task: tasks may need more turns and tools. */
  taskTimeoutMs: 10 * 60_000,
  /** Per-run cap on Claude Code's own cost estimate (a safety net, not billing). */
  maxBudgetUsd: 1,
  /** How often the worker looks for new runs when idle. */
  pollIntervalMs: 1_000,
  /** How often a running run refreshes its heartbeat and checks for Stop. */
  heartbeatMs: 1_000,
  /** A running run whose heartbeat is older than this has lost its worker. */
  staleAfterMs: 30_000,
  /** How often the worker looks for such runs. */
  recoveryIntervalMs: 30_000,
  /** At most this often, the reply written so far is saved for the browser. */
  progressWriteMs: 300,
  /** Tool round trips allowed in one run, when the agent has tools. */
  maxToolTurns: 10,
  /** How long a tool call waits for the owner's approval before it expires. */
  approvalTtlMs: 5 * 60_000,
  /** How often a waiting tool call checks for the owner's decision. */
  approvalPollMs: 500,
  /**
   * Claude Code's own limit per tool call. It must cover an approval wait plus
   * the tool's run, or Claude Code would give up while the owner decides.
   */
  toolCallTimeoutMs: 6 * 60_000,
  /** Automatic retries a task gets after a lost worker or provider outage (see decideAfterFailure). */
  taskAutoRetries: 1,
  /** Wait before an automatic retry; doubles with each attempt. */
  retryBackoffMs: 15_000,
  /** Earlier messages included as context: at most this many… */
  historyMessages: 20,
  /** …and at most this many characters, dropping the oldest first. */
  historyCharacters: 60_000,
} as const;

/** Runs one worker may execute at once, whatever their kind. */
export const MAX_WORKER_CONCURRENCY = 3;

/**
 * How many runs the worker executes at once: SOLAS_WORKER_CONCURRENCY, from 1
 * to MAX_WORKER_CONCURRENCY. One by default, to protect the owner's plan
 * limits and the machine; anything invalid also means one.
 */
export function workerConcurrency(value = process.env.SOLAS_WORKER_CONCURRENCY): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return 1;
  return Math.min(parsed, MAX_WORKER_CONCURRENCY);
}

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
