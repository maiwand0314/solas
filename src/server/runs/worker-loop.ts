import "server-only";
import { setTimeout as sleep } from "node:timers/promises";
import { truncate, type Logger } from "@/server/logger";
import type { RunExecutor } from "./executor";

type LoopOptions = {
  executor: Pick<RunExecutor, "claimNextRun" | "executeRun" | "recoverStaleRuns">;
  /** Runs executed at once. Claims stop while every slot is busy. */
  concurrency: number;
  limits: { pollIntervalMs: number; recoveryIntervalMs: number };
  log: Logger;
  /** Checked between steps; once true, no new run is claimed. */
  shouldStop: () => boolean;
};

/**
 * The worker's job loop. Claims runs while it has a free slot, executes each
 * one in the background, and looks for runs whose worker died every
 * recoveryIntervalMs. A database outage doesn't end the loop: it waits and
 * tries again. When asked to stop, it claims nothing new and waits for the
 * runs in progress to finish (the caller aborts them first).
 */
export async function runWorkerLoop({ executor, concurrency, limits, log, shouldStop }: LoopOptions): Promise<void> {
  const inFlight = new Set<Promise<void>>();

  async function recover() {
    try {
      const recovered = await executor.recoverStaleRuns();
      if (recovered > 0) log("warn", "worker.recovered_runs", { count: recovered });
    } catch (error) {
      log("error", "worker.recovery_failed", { error: message(error) });
    }
  }

  await recover();
  let lastRecovery = Date.now();

  while (!shouldStop()) {
    if (Date.now() - lastRecovery > limits.recoveryIntervalMs) {
      await recover();
      lastRecovery = Date.now();
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
