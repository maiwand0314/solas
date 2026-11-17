import "server-only";
import { desc, inArray, sql } from "drizzle-orm";
import { getDatabase, type Database } from "@/server/db/client";
import { workerFailures, workerInstances, type WorkerFailureRow, type WorkerInstanceRow, type WorkerStep } from "@/server/db/schema";
import { WORKER_HEALTH, type WorkerHealthLimits } from "./limits";

// The web app's side of worker health (M6C): read what the workers reported
// and decide what it means. Read-only: the web app can't start, stop, or
// signal a worker. All ages are measured against the database clock, the
// same clock the workers wrote with.

export type MonitoredStep = Exclude<WorkerStep, "queue">;
export const MONITORED_STEPS: MonitoredStep[] = ["scheduler", "notifications", "recovery"];

export type WorkerFailureView = Pick<WorkerFailureRow, "id" | "workerId" | "step" | "code" | "message" | "occurredAt">;

export type StepState =
  /** Succeeded recently, and no failure since. */
  | "ok"
  /** The newest attempt failed. */
  | "failing"
  /** No success for longer than expected, failure or not (e.g. it hangs). */
  | "overdue"
  /** Hasn't completed yet, but the worker only just started. */
  | "starting";

export type WorkerStepView = { step: MonitoredStep; state: StepState; lastOkAt: Date | null; lastFailure: WorkerFailureView | null };

export type WorkerInstanceState = "healthy" | "degraded" | "stopped" | "stale";

export type WorkerInstanceView = Pick<WorkerInstanceRow, "id" | "hostname" | "pid" | "startedAt" | "lastHeartbeatAt" | "stoppedAt"> & {
  state: WorkerInstanceState;
  steps: WorkerStepView[];
  /** A recent failure to claim runs (usually the database). */
  queueFailure: WorkerFailureView | null;
};

export type WorkerStatus =
  /** The database couldn't be read, so nothing is known about the worker. */
  | { state: "unavailable" }
  /** No worker has reported since health reporting existed (or within the retention period). */
  | { state: "not_observed"; checkedAt: Date }
  | {
      /**
       * healthy: at least one live worker, and every live worker's steps work.
       * degraded: a live worker, but a step is failing or overdue.
       * stopped: no live worker; the newest one stopped gracefully or went stale.
       */
      state: "healthy" | "degraded" | "stopped";
      checkedAt: Date;
      instances: WorkerInstanceView[];
      recentFailures: WorkerFailureView[];
    };

type Thresholds = Pick<WorkerHealthLimits, "staleAfterMs" | "stepOverdueAfterMs" | "recoveryOverdueAfterMs" | "queueFailureWindowMs">;

const OK_AT: Record<MonitoredStep, keyof WorkerInstanceRow> = {
  scheduler: "lastSchedulerOkAt",
  notifications: "lastNotificationsOkAt",
  recovery: "lastRecoveryOkAt",
};

/** Pure: what one worker's report means at `now`. Exported for tests. */
export function assessInstance(
  row: WorkerInstanceRow,
  latestFailures: WorkerFailureView[],
  now: Date,
  limits: Thresholds = WORKER_HEALTH,
): WorkerInstanceView {
  const age = (date: Date) => now.getTime() - date.getTime();
  const failureOf = (step: WorkerStep) =>
    latestFailures.filter((f) => f.workerId === row.id && f.step === step).sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0] ?? null;

  const steps = MONITORED_STEPS.map((step): WorkerStepView => {
    const lastOkAt = row[OK_AT[step]] as Date | null;
    const lastFailure = failureOf(step);
    const overdueAfter = step === "recovery" ? limits.recoveryOverdueAfterMs : limits.stepOverdueAfterMs;
    let state: StepState;
    // >=: dates reach JavaScript in whole milliseconds, so a tie can't be ordered; assume the worse.
    if (lastFailure && (!lastOkAt || lastFailure.occurredAt >= lastOkAt)) state = "failing";
    else if (age(lastOkAt ?? row.startedAt) > overdueAfter) state = "overdue";
    else state = lastOkAt ? "ok" : "starting";
    return { step, state, lastOkAt, lastFailure };
  });

  const queue = failureOf("queue");
  const queueFailure = queue && age(queue.occurredAt) <= limits.queueFailureWindowMs ? queue : null;

  let state: WorkerInstanceState;
  if (row.stoppedAt) state = "stopped";
  else if (age(row.lastHeartbeatAt) > limits.staleAfterMs) state = "stale";
  else if (queueFailure || steps.some((s) => s.state === "failing" || s.state === "overdue")) state = "degraded";
  else state = "healthy";

  const { id, hostname, pid, startedAt, lastHeartbeatAt, stoppedAt } = row;
  return { id, hostname, pid, startedAt, lastHeartbeatAt, stoppedAt, state, steps, queueFailure };
}

/** Pure: the overall state from every worker's view. */
export function overallState(instances: WorkerInstanceView[]): "healthy" | "degraded" | "stopped" {
  const live = instances.filter((i) => i.state === "healthy" || i.state === "degraded");
  if (live.length === 0) return "stopped";
  return live.some((i) => i.state === "degraded") ? "degraded" : "healthy";
}

/** How many workers the status shows: the newest by heartbeat. */
const SHOWN_INSTANCES = 5;
const SHOWN_FAILURES = 10;

export function createWorkerStatusService({ db, limits = WORKER_HEALTH }: { db: Database; limits?: Thresholds }) {
  async function read(): Promise<WorkerStatus> {
    const [{ now }] = await db.execute<{ now: string }>(sql`select now()::text as now`);
    const checkedAt = new Date(now);
    const rows = await db.select().from(workerInstances).orderBy(desc(workerInstances.lastHeartbeatAt)).limit(SHOWN_INSTANCES);
    if (rows.length === 0) return { state: "not_observed", checkedAt };

    const ids = rows.map((r) => r.id);
    const columns = {
      id: workerFailures.id,
      workerId: workerFailures.workerId,
      step: workerFailures.step,
      code: workerFailures.code,
      message: workerFailures.message,
      occurredAt: workerFailures.occurredAt,
    };
    const [latestPerStep, recentFailures] = await Promise.all([
      db
        .selectDistinctOn([workerFailures.workerId, workerFailures.step], columns)
        .from(workerFailures)
        .where(inArray(workerFailures.workerId, ids))
        .orderBy(workerFailures.workerId, workerFailures.step, desc(workerFailures.occurredAt)),
      db.select(columns).from(workerFailures).where(inArray(workerFailures.workerId, ids)).orderBy(desc(workerFailures.occurredAt)).limit(SHOWN_FAILURES),
    ]);

    const instances = rows.map((row) => assessInstance(row, latestPerStep, checkedAt, limits));
    return { state: overallState(instances), checkedAt, instances, recentFailures };
  }

  return { read };
}

export function getWorkerStatusService() {
  return createWorkerStatusService({ db: getDatabase() });
}
