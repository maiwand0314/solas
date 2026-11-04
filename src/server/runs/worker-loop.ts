import "server-only";
import { setTimeout as sleep } from "node:timers/promises";
import { truncate, type Logger } from "@/server/logger";
import type { RunExecutor } from "./executor";

type LoopOptions = {
  executor: Pick<RunExecutor, "claimNextRun" | "executeRun" | "recoverStaleRuns">;
  /**
   * Automations (M6A): checked every schedulerIntervalMs. It only creates
   * tasks (pending runs), which this same loop then claims like any other.
   */
  scheduler?: { tick(): Promise<{ started: number; skipped: number; missed: number }> };
  /** Runs executed at once. Claims stop while every slot is busy. */
  concurrency: number;
  limits: { pollIntervalMs: number; recoveryIntervalMs: number; schedulerIntervalMs?: number };
  log: Logger;
  /** Checked between steps; once true, no new run is claimed. */
  shouldStop: () => boolean;
};

/**
 * The worker's job loop. Claims runs while it has a free slot, executes each
 * one in the background, looks for runs whose worker died every
 * recoveryIntervalMs, and (with a scheduler) starts due automations. A database outage doesn't end the loop: it waits and
 * tries again. When asked to stop, it claims nothing new and waits for the
 * runs in progress to finish (the caller aborts them first).
 */
export async function runWorkerLoop({ executor, scheduler, concurrency, limits, log, shouldStop }: LoopOptions): Promise<void> {
  const inFlight = new Set<Promise<void>>();

  async function recover() {
    try {
      const recovered = await executor.recoverStaleRuns();
      if (recovered > 0) log("warn", "worker.recovered_runs", { count: recovered });
    } catch (error) {
      log("error", "worker.recovery_failed", { error: message(error) });
    }
  }

  async function schedule() {
    if (!scheduler) return;
    try {
      const result = await scheduler.tick();
      if (result.started + result.skipped + result.missed > 0) log("info", "worker.scheduled", result);
    } catch (error) {
      log("error", "worker.scheduler_failed", { error: message(error) });
    }
  }

  await recover();
  let lastRecovery = Date.now();
  // After recovery, so a restarted worker first settles what the old one left.
  await schedule();
  let lastSchedule = Date.now();

  while (!shouldStop()) {
    if (Date.now() - lastRecovery > limits.recoveryIntervalMs) {
      await recover();
      lastRecovery = Date.now();
    }
    if (scheduler && Date.now() - lastSchedule > (limits.schedulerIntervalMs ?? 15_000)) {
      await schedule();
      lastSchedule = Date.now();
    }

    if (inFlight.size < concurrency) {
      let claimed = false;
      try {
        const run = await executor.claimNextRun();
        if (run) {
          claimed = true;
          const execution: Promise<void> = executor
            .executeRun(run)
            .then(() => undefined)
            .catch((error) => log("error", "worker.run_error", { runId: run.id, error: message(error) }))
            .finally(() => inFlight.delete(execution));
          inFlight.add(execution);
        }
      } catch (error) {
        // Usually the database is down. Keep going; it may come back.
        log("error", "worker.loop_error", { error: message(error) });
        await sleep(limits.pollIntervalMs * 5);
        continue;
      }
      // Claimed one: look for the next straight away, while a slot is free.
      if (claimed) continue;
    }

    // Idle or full: wait for the poll interval, or for a slot to free up.
    await Promise.race([sleep(limits.pollIntervalMs), ...inFlight]);
  }

  await Promise.allSettled(inFlight);
}

function message(error: unknown): string {
  return truncate(error instanceof Error ? error.message : String(error));
}
