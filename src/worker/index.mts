// The Solas worker: the only process that runs agents. It has no network
// listener. It talks to PostgreSQL (to find work and save results) and, through
// the Claude Agent SDK, to Anthropic. Start it next to the web app:
//
//   npm run worker
//
// The .mts extension makes this an ES module, so top-level await works.
// It runs one agent at a time unless SOLAS_WORKER_CONCURRENCY says otherwise
// (at most 3). Stop it with Ctrl+C: runs in progress are stopped and recorded
// (a task attempt may be retried automatically when that is safe), so nothing
// stays "running" forever. Pending runs and queued tasks wait in PostgreSQL
// and are picked up when the worker starts again.
//
// It also runs the automation scheduler (M6A), which turns due schedules into
// ordinary tasks. Schedules live in PostgreSQL too: a stopped worker starts
// nothing, and a run it was too late for is recorded as missed, not caught up.
//
// It reports its own health (M6C) in worker_instances: a heartbeat on a timer,
// whether or not there is work, and when each step last succeeded. Settings
// shows it. Under launchd (scripts/launchd/solas-worker.sh) a crash is
// restarted; a graceful stop (SIGTERM, exit code 0) is not.

import { randomUUID } from "node:crypto";
import os from "node:os";
import { closeDatabase, createDatabase } from "@/server/db/client";
import { AUTOMATION_LIMITS } from "@/lib/automations/limits";
import { createScheduler } from "@/server/automations/scheduler";
import { createNotificationSync } from "@/server/notifications/sync";
import { createWorkerHealth } from "@/server/workers/health";
import { WORKER_HEALTH } from "@/server/workers/limits";
import { jsonLogger as log } from "@/server/logger";
import { providerRegistry } from "@/server/providers/registry";
import { RUN_LIMITS, prepareRuntimeDirectory, workerConcurrency } from "@/server/runs/config";
import { createRunExecutor } from "@/server/runs/executor";
import { runWorkerLoop } from "@/server/runs/worker-loop";
import { createClaudeAgentSdkRuntime } from "@/server/runtime/claude-agent-sdk";
import { createToolInvoker } from "@/server/tools/invoker";
import { toolRegistry } from "@/server/tools/registry";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  log("error", "worker.misconfigured", { reason: "DATABASE_URL is not set. Copy .env.example to .env.local." });
  process.exit(1);
}

// Recorded on every run this worker claims: host, process, and a random part
// so a restarted worker with a reused PID is still a different owner.
const workerId = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const concurrency = workerConcurrency();
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
  // Only tools the registry marks as read-only make a lost task attempt safe to repeat.
  isReadOnlyTool: (toolId) => toolRegistry.get(toolId)?.sideEffects === false,
  workerId,
  log,
});

// Automations (M6A): turns due schedules into ordinary tasks for the loop below.
const scheduler = createScheduler({ db, providers: providerRegistry, log });

// Notifications (M6B): the in-app inbox, derived from rows the engine already writes.
const notifications = createNotificationSync(db);

// Worker health (M6C): written by this process only, read by Settings.
const health = createWorkerHealth({ db, workerId, hostname: os.hostname(), pid: process.pid, log });

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log("info", "worker.stopping", { signal });
  executor.abortActiveRuns();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// After the signal handlers, so a SIGTERM while the database is slow is still graceful.
await health.heartbeat();
const heartbeatTimer = setInterval(() => void health.heartbeat(), WORKER_HEALTH.heartbeatIntervalMs);

log("info", "worker.started", {
  workerId,
  timeoutMs: RUN_LIMITS.timeoutMs,
  taskTimeoutMs: RUN_LIMITS.taskTimeoutMs,
  concurrency,
});

await runWorkerLoop({
  executor,
  scheduler,
  notifications,
  health,
  concurrency,
  limits: { ...RUN_LIMITS, schedulerIntervalMs: AUTOMATION_LIMITS.checkIntervalMs },
  log,
  shouldStop: () => stopping,
});

clearInterval(heartbeatTimer);
await health.stopped();
await closeDatabase(db);
log("info", "worker.stopped");
