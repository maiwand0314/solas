// Safeguards for automations (M6A), in one place so they're easy to find,
// explain, and change. Client-safe: the form checks the same numbers as the
// server. Conservative on purpose: every scheduled run is a real Claude run
// that counts against the owner's plan.

export const AUTOMATION_LIMITS = {
  /** The shortest "every N minutes/hours" schedule. */
  minIntervalMinutes: 60,
  /** The longest one (a week); longer schedules are weekly or monthly. */
  maxIntervalMinutes: 7 * 24 * 60,
  /** Automations that may be scheduled at the same time. */
  maxActiveAutomations: 10,
  /**
   * Runs per day across all automations: checked when an automation is
   * saved (worst-case day of every active schedule) and again by the
   * scheduler (tasks it actually created in the last 24 hours).
   */
  maxRunsPerDay: 24,
  /** Automation tasks that may be queued or running at once, across all automations. */
  maxConcurrentExecutions: 2,
  /**
   * A run that couldn't start within this long after its time (the worker
   * was stopped) is recorded as missed and skipped, never caught up later.
   */
  missedAfterMs: 10 * 60_000,
  /** After a Claude usage-limit error, scheduled runs are skipped for this long. */
  usageLimitCooldownMs: 60 * 60_000,
  /** Automatic retries an automation's task gets (same safe policy as any task). */
  taskAutoRetries: 1,
  /** How often the worker checks for automations that are due. */
  checkIntervalMs: 15_000,
  /** Field lengths. */
  name: 80,
  description: 500,
} as const;

/** The same safeguards as plain numbers, so tests can pass their own. */
export type AutomationLimitValues = { [K in keyof typeof AUTOMATION_LIMITS]: number };

export const DEFAULT_TIME_ZONE = "Europe/Oslo";
