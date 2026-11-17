import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduler } from "@/server/automations/scheduler";
import { closeDatabase, createDatabase } from "@/server/db/client";
import { agents, automations, tasks, workerFailures, workerInstances } from "@/server/db/schema";
import type { Logger } from "@/server/logger";
import { createNotificationSync } from "@/server/notifications/sync";
import { insertAgent, testProviders } from "@/server/runs/test-helpers";
import { runWorkerLoop } from "@/server/runs/worker-loop";
import { classifyFailure, createWorkerHealth } from "./health";
import { WORKER_HEALTH } from "./limits";
import { assessInstance, createWorkerStatusService, overallState } from "./status";

// Worker health (M6C) against the test database: what a worker writes about
// itself, and what the web app concludes from it. No real worker process and
// no Claude: the worker loop gets a fake executor that never claims a run.

const db = createDatabase(process.env.TEST_DATABASE_URL!);
const silentLog: Logger = () => {};
const status = createWorkerStatusService({ db });

let counter = 0;
function newHealth(overrides: Partial<Parameters<typeof createWorkerHealth>[0]> = {}) {
  counter++;
  return createWorkerHealth({ db, workerId: `test-host:${1000 + counter}:${counter}`, hostname: "test-host", pid: 1000 + counter, log: silentLog, ...overrides });
}

/** Moves a worker's report into the past, as if time had passed since it was written. */
async function age(workerId: string, ms: number) {
  const shift = sql.raw(`interval '${Math.round(ms / 1000)} seconds'`);
  await db.execute(sql`
    update worker_instances set
      started_at = started_at - ${shift},
      last_heartbeat_at = last_heartbeat_at - ${shift},
      last_scheduler_ok_at = last_scheduler_ok_at - ${shift},
      last_notifications_ok_at = last_notifications_ok_at - ${shift},
      last_recovery_ok_at = last_recovery_ok_at - ${shift}
    where id = ${workerId}`);
  await db.execute(sql`update worker_failures set occurred_at = occurred_at - ${shift} where worker_id = ${workerId}`);
}

async function healthyWorker() {
  const health = newHealth();
  await health.heartbeat();
  await Promise.all([health.succeeded("scheduler"), health.succeeded("notifications"), health.succeeded("recovery")]);
  return health;
}

beforeEach(async () => {
  await db.delete(workerInstances); // cascades to failures
  await db.delete(automations);
  await db.delete(agents);
});

afterAll(async () => {
  await db.delete(workerInstances);
  await closeDatabase(db);
});

describe("heartbeat and stale detection", () => {
  it("reports nothing until a worker has written a heartbeat", async () => {
    expect(await status.read()).toMatchObject({ state: "not_observed" });
  });

  it("an idle worker reports its presence with a heartbeat, without any run", async () => {
    await healthyWorker();
    const result = await status.read();
    expect(result.state).toBe("healthy");
    if (result.state !== "healthy") return;
    expect(result.instances).toHaveLength(1);
    expect(result.instances[0]).toMatchObject({ hostname: "test-host", state: "healthy", stoppedAt: null });
    // Nothing about it comes from runs or tasks.
    expect(await db.select().from(tasks)).toHaveLength(0);
  });

  it("a heartbeat updates the same row and moves it forward", async () => {
    const health = newHealth();
    await health.heartbeat();
    const [first] = await db.select().from(workerInstances);
    await age(first.id, 30_000);
    await health.heartbeat();
    const rows = await db.select().from(workerInstances);
    expect(rows).toHaveLength(1);
    expect(rows[0].lastHeartbeatAt.getTime()).toBeGreaterThanOrEqual(first.lastHeartbeatAt.getTime());
    expect(rows[0].startedAt.getTime()).toBe(first.startedAt.getTime() - 30_000);
  });

  it("a worker without a heartbeat for longer than staleAfterMs is stopped, not running", async () => {
    await healthyWorker();
    const [row] = await db.select().from(workerInstances);
    await age(row.id, WORKER_HEALTH.staleAfterMs + 5_000);
    const result = await status.read();
    expect(result.state).toBe("stopped");
    if (result.state === "stopped") expect(result.instances[0].state).toBe("stale");
  });

  it("a heartbeat alone isn’t healthy: a scheduler that never succeeds makes the worker degraded", async () => {
    const health = newHealth();
    await health.heartbeat();
    await health.succeeded("notifications");
    await health.succeeded("recovery");
    // Just started: the scheduler may not have finished its first tick yet.
    expect((await status.read()).state).toBe("healthy");

    const [row] = await db.select().from(workerInstances);
    await age(row.id, WORKER_HEALTH.stepOverdueAfterMs + 5_000);
    await health.heartbeat(); // alive now…
    await health.succeeded("notifications");
    await health.succeeded("recovery");
    const result = await status.read(); // …but its scheduler hasn't worked for minutes
    expect(result.state).toBe("degraded");
    if (result.state === "degraded") {
      expect(result.instances[0].steps.find((s) => s.step === "scheduler")?.state).toBe("overdue");
    }
  });
});

describe("shutdown", () => {
  it("a graceful shutdown records stopped_at; the status says it stopped normally", async () => {
    const health = await healthyWorker();
    await health.stopped();
    const [row] = await db.select().from(workerInstances);
    expect(row.stoppedAt).not.toBeNull();
    const result = await status.read();
    expect(result.state).toBe("stopped");
    if (result.state === "stopped") expect(result.instances[0].state).toBe("stopped");
  });

  it("an unexpected termination leaves no stopped_at: the heartbeat goes stale instead", async () => {
    await healthyWorker(); // "killed": stopped() never runs
    const [row] = await db.select().from(workerInstances);
    expect(row.stoppedAt).toBeNull();
    await age(row.id, WORKER_HEALTH.staleAfterMs + 1_000);
    const result = await status.read();
    if (result.state !== "stopped") throw new Error(`expected stopped, got ${result.state}`);
    expect(result.instances[0].state).toBe("stale");
  });
});

describe("step failures", () => {
  it.each(["scheduler", "notifications", "recovery"] as const)("a failing %s makes a live worker degraded, with a safe message", async (step) => {
    const health = await healthyWorker();
    await health.failed(step, Object.assign(new Error("relation does not exist: secret_table"), { code: "42P01" }));
    const result = await status.read();
    expect(result.state).toBe("degraded");
    if (result.state !== "degraded") return;
    const view = result.instances[0].steps.find((s) => s.step === step)!;
    expect(view.state).toBe("failing");
    expect(view.lastFailure).toMatchObject({ code: "query_failed", message: "A database query failed. (PostgreSQL 42P01)" });
    expect(result.recentFailures[0].message).not.toContain("secret_table");
  });

  it("a later success clears a failure", async () => {
    const health = await healthyWorker();
    await health.failed("scheduler", new Error("boom"));
    expect((await status.read()).state).toBe("degraded");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await health.succeeded("scheduler");
    expect((await status.read()).state).toBe("healthy");
  });

  it("a recent failure to claim runs makes the worker degraded", async () => {
    const health = await healthyWorker();
    await health.failed("queue", Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }));
    const result = await status.read();
    expect(result.state).toBe("degraded");
    if (result.state === "degraded") expect(result.instances[0].queueFailure?.code).toBe("database_unavailable");
  });

  it("the worker loop reports each step's success and failure", async () => {
    const calls: string[] = [];
    const health = {
      succeeded: async (step: string) => void calls.push(`ok:${step}`),
      failed: async (step: string) => void calls.push(`failed:${step}`),
    };
    const fail = () => Promise.reject(new Error("down"));
    let iterations = 0;
    await runWorkerLoop({
      executor: { recoverStaleRuns: fail, claimNextRun: fail, executeRun: fail },
      scheduler: { tick: fail },
      notifications: { sync: async () => ({ created: 0 }) },
      health,
      concurrency: 1,
      limits: { pollIntervalMs: 1, recoveryIntervalMs: 60_000, schedulerIntervalMs: 60_000 },
      log: silentLog,
      shouldStop: () => iterations++ > 0,
    });
    expect(calls).toEqual(["failed:recovery", "failed:scheduler", "ok:notifications", "failed:queue"]);
  });
});

describe("classifying failures", () => {
  it("recognizes a database that is down, also inside a wrapped error", () => {
    expect(classifyFailure(Object.assign(new Error("x"), { code: "ECONNREFUSED" })).code).toBe("database_unavailable");
    expect(classifyFailure(new Error("Failed query", { cause: Object.assign(new Error("y"), { code: "57P01" }) })).code).toBe("database_unavailable");
    expect(classifyFailure(Object.assign(new Error("z"), { code: "08006" })).code).toBe("database_unavailable");
  });

  it("never copies the raw error text, which may hold a connection string", () => {
    const failure = classifyFailure(new Error("could not connect to postgres://solas:hunter2@127.0.0.1/solas"));
    expect(failure).toEqual({ code: "unexpected", message: expect.any(String) });
    expect(failure.message).not.toContain("hunter2");
  });
});

describe("several workers", () => {
  it("each worker has its own row; one never overwrites another", async () => {
    const a = await healthyWorker();
    const b = await healthyWorker();
    await a.failed("scheduler", new Error("boom"));
    await b.stopped();
    const rows = await db.select().from(workerInstances);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.stoppedAt)).toHaveLength(1);
    expect(await db.select().from(workerFailures)).toHaveLength(1);
    // The live one is failing; the one that stopped doesn't count.
    expect((await status.read()).state).toBe("degraded");
  });

  it("a crashed worker doesn't hide a healthy one that replaced it", async () => {
    await healthyWorker();
    const [old] = await db.select().from(workerInstances);
    await age(old.id, WORKER_HEALTH.staleAfterMs * 2);
    await healthyWorker();
    const result = await status.read();
    expect(result.state).toBe("healthy");
    if (result.state === "healthy") expect(result.instances.map((i) => i.state)).toEqual(["healthy", "stale"]);
  });

  it("overall state: degraded if any live worker is, stopped if none is live", () => {
    const view = (state: "healthy" | "degraded" | "stale" | "stopped") => ({ state }) as Parameters<typeof overallState>[0][number];
    expect(overallState([view("healthy"), view("degraded")])).toBe("degraded");
    expect(overallState([view("healthy"), view("stale")])).toBe("healthy");
    expect(overallState([view("stale"), view("stopped")])).toBe("stopped");
  });
});

describe("database outage", () => {
  it("nothing throws while the database is down; failures from that time are saved once it is back", async () => {
    const health = await healthyWorker();
    const execute = vi.spyOn(db, "execute").mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    await expect(health.heartbeat()).resolves.toBeUndefined();
    await expect(health.failed("scheduler", Object.assign(new Error("down"), { code: "ECONNREFUSED" }))).resolves.toBeUndefined();
    await expect(health.succeeded("recovery")).resolves.toBeUndefined();
    await expect(health.stopped()).resolves.toBeUndefined();
    expect(health.pendingCount()).toBe(1);

    execute.mockRestore();
    await health.heartbeat();
    expect(health.pendingCount()).toBe(0);
    const failures = await db.select().from(workerFailures);
    expect(failures).toMatchObject([{ step: "scheduler", code: "database_unavailable" }]);
  });

  it("keeps at most maxPendingFailures in memory during a long outage", async () => {
    const health = newHealth({ limits: { ...WORKER_HEALTH, maxPendingFailures: 3 } });
    const execute = vi.spyOn(db, "execute").mockRejectedValue(new Error("down"));
    for (let i = 0; i < 10; i++) await health.failed("queue", new Error("down"));
    execute.mockRestore();
    expect(health.pendingCount()).toBe(3);
  });

  it("a worker that started while the database was down appears once it is back", async () => {
    const health = newHealth();
    const execute = vi.spyOn(db, "execute").mockRejectedValue(new Error("down"));
    await health.heartbeat();
    execute.mockRestore();
    expect(await db.select().from(workerInstances)).toHaveLength(0);
    await health.heartbeat();
    expect(await db.select().from(workerInstances)).toHaveLength(1);
  });
});

describe("retention", () => {
  it("deletes workers gone longer than the retention period and caps failures per worker", async () => {
    const limits = { ...WORKER_HEALTH, maxFailuresPerWorker: 3, pruneIntervalMs: 0 };
    const old = await healthyWorker();
    await old.stopped();
    const [oldRow] = await db.select().from(workerInstances);
    await age(oldRow.id, WORKER_HEALTH.retentionMs + 60_000);

    const current = newHealth({ limits });
    await current.heartbeat();
    for (let i = 0; i < 6; i++) await current.failed("scheduler", new Error("boom"));
    await current.heartbeat(); // applies the retention policy

    const rows = await db.select().from(workerInstances);
    expect(rows.map((r) => r.id)).not.toContain(oldRow.id);
    expect(await db.select().from(workerFailures)).toHaveLength(3);
  });
});

describe("restart safety", () => {
  it("a worker that crashes after scheduling, and one that replaces it, start a due automation once", async () => {
    const due = new Date(Date.now() - 1_000);
    const agent = await insertAgent(db, { name: "Briefing agent" });
    const [automation] = await db
      .insert(automations)
      .values({
        name: "Daily briefing",
        agentId: agent.id,
        instructions: "Brief me.",
        schedule: { kind: "daily", time: "08:00" },
        timeZone: "Europe/Oslo",
        enabled: true,
        nextRunAt: due,
      })
      .returning();

    async function workerRun() {
      const health = newHealth();
      await health.heartbeat();
      let iterations = 0;
      await runWorkerLoop({
        // Claims nothing, so the task stays queued and nothing is executed.
        executor: { recoverStaleRuns: async () => 0, claimNextRun: async () => null, executeRun: async () => undefined as never },
        scheduler: createScheduler({ db, providers: testProviders, log: silentLog }),
        notifications: createNotificationSync(db),
        health,
        concurrency: 1,
        limits: { pollIntervalMs: 1, recoveryIntervalMs: 60_000, schedulerIntervalMs: 60_000 },
        log: silentLog,
        shouldStop: () => iterations++ > 0,
      });
      // No stopped(): the first one "crashes"; the second is just cut short.
    }

    await workerRun();
    // Worst case: the restarted worker sees the same slot as still due (as if the
    // first one died before its next run time was saved). The occurrence is unique per slot.
    await db.update(automations).set({ nextRunAt: due }).where(eq(automations.id, automation.id));
    await workerRun();

    const created = await db.select().from(tasks).where(eq(tasks.automationId, automation.id));
    expect(created).toHaveLength(1);
    expect(await db.select().from(workerInstances)).toHaveLength(2);
  });
});

describe("assessInstance", () => {
  it("is 'starting' before a step's first success, within the grace period", () => {
    const now = new Date("2026-11-17T10:00:00Z");
    const row = {
      id: "w",
      hostname: "h",
      pid: 1,
      startedAt: new Date(now.getTime() - 5_000),
      lastHeartbeatAt: now,
      stoppedAt: null,
      lastSchedulerOkAt: null,
      lastNotificationsOkAt: null,
      lastRecoveryOkAt: null,
    };
    const view = assessInstance(row, [], now);
    expect(view.state).toBe("healthy");
    expect(view.steps.every((s) => s.state === "starting")).toBe(true);
  });
});
