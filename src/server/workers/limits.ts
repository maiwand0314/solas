import "server-only";
import { AUTOMATION_LIMITS } from "@/lib/automations/limits";
import { RUN_LIMITS } from "@/server/runs/config";

/**
 * Worker health (M6C), in one place: how often a worker reports, when the
 * web app stops trusting a report, and how long reports are kept.
 */
export const WORKER_HEALTH = {
  /** How often a worker writes its heartbeat, with or without work. */
  heartbeatIntervalMs: 10_000,
  /** No heartbeat for this long: the worker is treated as stopped (crashed, killed, or asleep). */
  staleAfterMs: 60_000,
  /**
   * A live worker whose scheduler or notification sync hasn't succeeded for
   * this long is degraded, even without a recorded failure (e.g. a step that hangs).
   * Several scheduler intervals, so one slow tick doesn't flag it.
   */
  stepOverdueAfterMs: Math.max(2 * 60_000, 6 * AUTOMATION_LIMITS.checkIntervalMs),
  /** The same for the recovery check, which runs less often. */
  recoveryOverdueAfterMs: Math.max(2 * 60_000, 4 * RUN_LIMITS.recoveryIntervalMs),
  /** A failure to claim runs counts as current for this long (claims succeed silently). */
  queueFailureWindowMs: 2 * 60_000,
  /**
   * Retention: a worker's row (and its failures) is deleted this long after
   * its last heartbeat, and a failure is deleted after this long anyway…
   */
  retentionMs: 7 * 24 * 60 * 60_000,
  /** …and only the newest failures of each worker are kept. */
  maxFailuresPerWorker: 50,
  /** How often a worker applies the retention policy. */
  pruneIntervalMs: 60 * 60_000,
  /** Failures kept in memory while the database can't be written, saved once it can. */
  maxPendingFailures: 20,
} as const;

/** The same numbers as plain numbers, so tests can pass their own. */
export type WorkerHealthLimits = { [K in keyof typeof WORKER_HEALTH]: number };
