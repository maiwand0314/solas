// The Solas worker: the only process that runs agents. It has no network
// listener. It talks to PostgreSQL (to find work and save results) and, through
// the Claude Agent SDK, to Anthropic. Start it next to the web app:
//
//   npm run worker
//
// The .mts extension makes this an ES module, so top-level await works.
// It runs one agent at a time. Stop it with Ctrl+C: a run in progress is
// stopped and marked failed, so it never stays "running" forever. Pending
// runs wait in PostgreSQL and are picked up when the worker starts again.

import { setTimeout as sleep } from "node:timers/promises";
import { closeDatabase, createDatabase } from "@/server/db/client";
import { jsonLogger as log, truncate } from "@/server/logger";
import { providerRegistry } from "@/server/providers/registry";
import { RUN_LIMITS, prepareRuntimeDirectory } from "@/server/runs/config";
import { createRunExecutor } from "@/server/runs/executor";
import { createClaudeAgentSdkRuntime } from "@/server/runtime/claude-agent-sdk";
import { createToolInvoker } from "@/server/tools/invoker";
import { toolRegistry } from "@/server/tools/registry";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  log("error", "worker.misconfigured", { reason: "DATABASE_URL is not set. Copy .env.example to .env.local." });
  process.exit(1);
}

const db = createDatabase(databaseUrl);
const executor = createRunExecutor({
  db,
  providers: providerRegistry,
  runtimes: [
    createClaudeAgentSdkRuntime({
      workDir: prepareRuntimeDirectory(),
      maxBudgetUsd: RUN_LIMITS.maxBudgetUsd,
      maxToolTurns: RUN_LIMITS.maxToolTurns,
      toolCallTimeoutMs: RUN_LIMITS.toolCallTimeoutMs,
      log,
    }),
  ],
  tools: createToolInvoker({ db, registry: toolRegistry, log, limits: RUN_LIMITS }),
  log,
});

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log("info", "worker.stopping", { signal });
  executor.abortActiveRun();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log("info", "worker.started", { pid: process.pid, timeoutMs: RUN_LIMITS.timeoutMs, concurrency: 1 });

/** Marks runs whose worker died as failed (see recoverStaleRuns). */
async function recover() {
  try {
    const recovered = await executor.recoverStaleRuns();
    if (recovered > 0) log("warn", "worker.recovered_runs", { count: recovered });
  } catch (error) {
    log("error", "worker.recovery_failed", { error: truncate(error instanceof Error ? error.message : String(error)) });
  }
}

await recover();
let lastRecovery = Date.now();

while (!stopping) {
  if (Date.now() - lastRecovery > RUN_LIMITS.recoveryIntervalMs) {
    await recover();
    lastRecovery = Date.now();
  }
  let didWork = false;
  try {
    didWork = await executor.runOnce();
  } catch (error) {
    // Usually the database is down. Keep going; it may come back.
    log("error", "worker.loop_error", { error: truncate(error instanceof Error ? error.message : String(error)) });
    await sleep(RUN_LIMITS.pollIntervalMs * 5);
  }
  if (!didWork && !stopping) await sleep(RUN_LIMITS.pollIntervalMs);
}

await closeDatabase(db);
log("info", "worker.stopped");
