import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AUTOMATION_LIMITS } from "@/lib/automations/limits";
import { formatInTimeZone } from "@/lib/automations/schedule";
import { createConversationService } from "@/server/conversations/service";
import { closeDatabase, createDatabase } from "@/server/db/client";
import {
  agentToolPermissions,
  agents,
  automationOccurrences,
  automations,
  runs,
  taskEvents,
  tasks,
  toolCalls,
} from "@/server/db/schema";
import type { Logger } from "@/server/logger";
import { createRunExecutor, type ExecutorLimits } from "@/server/runs/executor";
import { fakeRuntime, insertAgent, testProviders } from "@/server/runs/test-helpers";
import type { RunInput, RunResult } from "@/server/runtime/types";
import { createToolInvoker } from "@/server/tools/invoker";
import { createToolRegistry } from "@/server/tools/registry";
import type { AnyToolDefinition } from "@/server/tools/types";
import { createScheduler } from "./scheduler";
import { createAutomationService } from "./service";

// Automations (M6A) on the backend, against the test database: the service
// (web side), the scheduler (worker side), and the existing run executor
// that executes the tasks they create. A controlled clock stands in for real
// time, and a fake runtime for Claude: nothing here calls the real service.

const db = createDatabase(process.env.TEST_DATABASE_URL!);
const silentLog: Logger = () => {};
const OSLO = "Europe/Oslo";

/** The controlled clock: tests move it instead of waiting. 15 Jan 2026 is winter time (UTC+1). */
let now = new Date("2026-01-15T06:00:00Z");
const clock = () => now;
const setNow = (iso: string) => (now = new Date(iso));

const limits = { ...AUTOMATION_LIMITS, maxRunsPerDay: 100, maxConcurrentExecutions: 5 };
const service = createAutomationService({ db, providers: testProviders, limits, clock });
const schedulerWith = (overrides: Partial<typeof limits> = {}) =>
  createScheduler({ db, providers: testProviders, log: silentLog, limits: { ...limits, ...overrides }, clock });
const scheduler = schedulerWith();
const conversations = createConversationService({ db, providers: testProviders });

const BRIEFING =
  "Summarize the latest developments in AI and software engineering. Clearly distinguish verified findings from " +
  "information that cannot be checked with currently available tools.";

function briefing(agentId: string, extra: Record<string, unknown> = {}) {
  return {
    name: "Daily AI Research Briefing",
    agentId,
    instructions: BRIEFING,
    schedule: { kind: "daily", time: "08:00" },
    timeZone: OSLO,
    ...extra,
  };
}

async function automationRow(id: string) {
  const [row] = await db.select().from(automations).where(eq(automations.id, id));
  return row;
}
async function occurrencesOf(id: string) {
  return db
    .select()
    .from(automationOccurrences)
    .where(eq(automationOccurrences.automationId, id))
    .orderBy(asc(automationOccurrences.scheduledFor));
}
async function tasksOf(id: string) {
  return db.select().from(tasks).where(eq(tasks.automationId, id)).orderBy(asc(tasks.createdAt));
}

// The worker side of a task: the existing executor, with a fake runtime and two test tools.
let toolRuns: string[] = [];
function testTool(overrides: Partial<AnyToolDefinition>): AnyToolDefinition {
  return {
    id: "look_up",
    name: "Look up",
    description: "Reads something.",
    input: z.strictObject({ text: z.string().max(40) }),
    output: z.strictObject({ text: z.string() }),
    risk: "low",
    approval: "optional",
    capability: "none",
    sideEffects: false,
    defaultMode: "allow",
    timeoutMs: 1_000,
    maxOutputChars: 1_000,
    summarizeInput: (input: { text: string }) => input.text,
    summarizeOutput: (output: { text: string }) => output.text,
    async execute(input: { text: string }) {
      toolRuns.push(`${overrides.id ?? "look_up"}:${input.text}`);
      return { text: `done ${input.text}` };
    },
    ...overrides,
  };
}
const registry = createToolRegistry([
  testTool({}),
  testTool({ id: "send_note", name: "Send note", description: "Sends a note.", sideEffects: true }),
]);
const executorLimits: ExecutorLimits = {
  timeoutMs: 5_000,
  taskTimeoutMs: 5_000,
  retryBackoffMs: 1_000,
  taskAutoRetries: 1,
  heartbeatMs: 20,
  staleAfterMs: 30_000,
  progressWriteMs: 10,
  historyMessages: 20,
  historyCharacters: 60_000,
};
function worker(behave: (input: RunInput, signal: AbortSignal) => Promise<RunResult>, approvalTtlMs = 5_000) {
  const { runtime, inputs } = fakeRuntime(behave);
  const executor = createRunExecutor({
    db,
    providers: testProviders,
    runtimes: [runtime],
    log: silentLog,
    tools: createToolInvoker({
      db,
      registry,
      log: silentLog,
      limits: { approvalTtlMs, approvalPollMs: 10 },
      workspaceFor: async () => "/nonexistent",
    }),
    isReadOnlyTool: (id) => registry.get(id)?.sideEffects === false,
    workerId: "test-worker",
    limits: executorLimits,
  });
  return { executor, inputs };
}
const answer = (text: string): RunResult => ({ status: "completed", text, usage: { inputTokens: 10, outputTokens: 5 } });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(check: () => Promise<T | undefined | null | false>, timeoutMs = 3_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await sleep(10);
  }
  throw new Error("Timed out waiting for a condition.");
}

beforeEach(async () => {
  await db.delete(agents); // cascades to automations, their history, tasks, and runs
  setNow("2026-01-15T06:00:00Z");
  toolRuns = [];
});

afterAll(async () => {
  await closeDatabase(db);
});

describe("managing automations", () => {
  it("stores the demo automation: every day at 08:00, Europe/Oslo", async () => {
    const agent = await insertAgent(db, { name: "Research Assistant" });
    const created = await service.create(briefing(agent.id));

    const row = await automationRow(created.id);
    expect(row).toMatchObject({
      name: "Daily AI Research Briefing",
      agentId: agent.id,
      instructions: BRIEFING,
      schedule: { kind: "daily", time: "08:00" },
      timeZone: "Europe/Oslo",
      enabled: true,
    });
    // 08:00 in Oslo in January is 07:00 UTC; it's 06:00 UTC now, so today.
    expect(row.nextRunAt?.toISOString()).toBe("2026-01-15T07:00:00.000Z");
    const detail = await service.get(created.id);
    expect(detail.scheduleText).toBe("Every day at 08:00");
    expect(detail.state).toBe("active");
    expect(detail.upcoming.map((d) => formatInTimeZone(d, OSLO))).toEqual([
      "Thu 15 Jan 2026, 08:00",
      "Fri 16 Jan 2026, 08:00",
      "Sat 17 Jan 2026, 08:00",
      "Sun 18 Jan 2026, 08:00",
      "Mon 19 Jan 2026, 08:00",
    ]);
  });

  it("uses Europe/Oslo when no time zone is given", async () => {
    const agent = await insertAgent(db);
    const input: Record<string, unknown> = briefing(agent.id);
    delete input.timeZone;
    expect((await service.create(input)).timeZone).toBe("Europe/Oslo");
  });

  it("refuses invalid schedules and schedules that would use Claude too often", async () => {
    const agent = await insertAgent(db);
    const attempt = (extra: Record<string, unknown>) => service.create(briefing(agent.id, extra));

    await expect(attempt({ schedule: { kind: "interval", every: 5, unit: "minutes" } })).rejects.toMatchObject({
      code: "validation_failed",
      fieldErrors: { schedule: [expect.stringContaining("to keep Claude usage reasonable")] },
    });
    await expect(attempt({ schedule: { kind: "daily", time: "25:00" } })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(attempt({ schedule: { kind: "weekly", days: [], time: "08:00" } })).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(attempt({ schedule: { kind: "monthly", day: 32, time: "08:00" } })).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(attempt({ timeZone: "Mars/Olympus_Mons" })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(attempt({ schedule: { kind: "once", date: "2026-01-14", time: "08:00" } })).rejects.toMatchObject({
      code: "validation_failed",
      message: "This time has already passed. Choose a time in the future.",
    });
    expect(await db.select().from(automations)).toHaveLength(0);
  });

  it("refuses a disabled agent while active, but allows saving it paused", async () => {
    const agent = await insertAgent(db, { enabled: false });
    await expect(service.create(briefing(agent.id))).rejects.toMatchObject({ code: "agent_unavailable" });
    const paused = await service.create(briefing(agent.id, { enabled: false }));
    expect(paused).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it("caps active automations and their runs per day", async () => {
    const agent = await insertAgent(db);
    const capped = createAutomationService({
      db,
      providers: testProviders,
      clock,
      limits: { ...limits, maxActiveAutomations: 2, maxRunsPerDay: 30 },
    });
    await capped.create(briefing(agent.id, { name: "Hourly", schedule: { kind: "interval", every: 1, unit: "hours" } }));
    // 24 + 24 runs a day would exceed 30.
    await expect(
      capped.create(briefing(agent.id, { name: "Hourly 2", schedule: { kind: "interval", every: 1, unit: "hours" } })),
    ).rejects.toMatchObject({ code: "limit_reached" });
    await capped.create(briefing(agent.id, { name: "Daily" }));
    await expect(capped.create(briefing(agent.id, { name: "Third" }))).rejects.toMatchObject({
      code: "limit_reached",
      message: expect.stringContaining("At most 2 automations"),
    });
    // Paused ones don't count.
    expect(await capped.create(briefing(agent.id, { name: "Third", enabled: false }))).toMatchObject({ enabled: false });
  });

  it("edits: a new name keeps the planned run; a new schedule recalculates it", async () => {
    const agent = await insertAgent(db);
    const created = await service.create(briefing(agent.id));
    const renamed = await service.update(created.id, briefing(agent.id, { name: "Morning briefing" }));
    expect(renamed.name).toBe("Morning briefing");
    expect(renamed.nextRunAt).toEqual(created.nextRunAt);

    const weekly = await service.update(
      created.id,
      briefing(agent.id, { name: "Morning briefing", schedule: { kind: "weekly", days: [1], time: "09:30" } }),
    );
    expect(formatInTimeZone(weekly.nextRunAt!, OSLO)).toBe("Mon 19 Jan 2026, 09:30");

    await service.create(briefing(agent.id, { name: "Other" }));
    await expect(service.update(created.id, briefing(agent.id, { name: "other" }))).rejects.toMatchObject({
      code: "name_taken",
    });
  });

  it("pauses (nothing scheduled) and resumes from now, without catching up", async () => {
    const agent = await insertAgent(db);
    const created = await service.create(briefing(agent.id));
    const paused = await service.setEnabled(created.id, false);
    expect(paused).toMatchObject({ enabled: false, nextRunAt: null });
    expect((await service.get(created.id)).state).toBe("paused");

    // Three days later: the runs while paused are simply not scheduled.
    setNow("2026-01-18T12:00:00Z");
    const resumed = await service.setEnabled(created.id, true);
    expect(resumed.nextRunAt?.toISOString()).toBe("2026-01-19T07:00:00.000Z");
    expect(await occurrencesOf(created.id)).toHaveLength(0);
  });

  it("won't resume a one-time automation whose time has passed", async () => {
    const agent = await insertAgent(db);
    const once = await service.create(briefing(agent.id, { schedule: { kind: "once", date: "2026-01-15", time: "12:00" } }));
    await service.setEnabled(once.id, false);
    setNow("2026-01-16T00:00:00Z");
    await expect(service.setEnabled(once.id, true)).rejects.toMatchObject({
      message: expect.stringContaining("time has passed"),
    });
  });

  it("deletes the automation and its history, but keeps the tasks it created", async () => {
    const agent = await insertAgent(db);
    const created = await service.create(briefing(agent.id));
    setNow("2026-01-15T07:00:05Z");
    await scheduler.tick();
    const [task] = await tasksOf(created.id);

    await service.remove(created.id);
    expect(await db.select().from(automations)).toHaveLength(0);
    expect(await db.select().from(automationOccurrences)).toHaveLength(0);
    const [kept] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(kept).toMatchObject({ automationId: null, title: task.title });
    await expect(service.remove(created.id)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("the scheduler", () => {
  it("runs a one-time automation once: a real task in the queue, linked to the automation", async () => {
    const agent = await insertAgent(db, { name: "Research Assistant" });
    const once = await service.create(briefing(agent.id, { name: "One-off", schedule: { kind: "once", date: "2026-01-15", time: "09:00" } }));

    setNow("2026-01-15T07:59:00Z"); // a minute early
    expect(await scheduler.tick()).toEqual({ started: 0, skipped: 0, missed: 0 });
    setNow("2026-01-15T08:00:03Z");
    expect(await scheduler.tick()).toEqual({ started: 1, skipped: 0, missed: 0 });

    const [task] = await tasksOf(once.id);
    expect(task).toMatchObject({
      status: "queued",
      agentId: agent.id,
      instructions: BRIEFING,
      title: "One-off — Thu 15 Jan 2026, 09:00",
      autoRetriesLeft: limits.taskAutoRetries,
    });
    expect(await db.select().from(runs).where(eq(runs.taskId, task.id))).toMatchObject([{ status: "pending", attempt: 1 }]);
    const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id)).orderBy(asc(taskEvents.id));
    expect(events.map((e) => e.type)).toEqual(["created", "queued"]);
    expect(events[0].message).toContain("The automation “One-off” created this task for Research Assistant");
    expect(await occurrencesOf(once.id)).toMatchObject([{ status: "started", taskId: task.id, trigger: "schedule" }]);
    expect(await automationRow(once.id)).toMatchObject({ nextRunAt: null });
    expect((await service.get(once.id)).state).toBe("finished");

    setNow("2026-01-16T08:00:00Z");
    await scheduler.tick();
    expect(await tasksOf(once.id)).toHaveLength(1);
  });

  it("runs a recurring automation each day and moves to the next run", async () => {
    const agent = await insertAgent(db);
    const daily = await service.create(briefing(agent.id));

    setNow("2026-01-15T07:00:02Z");
    await scheduler.tick();
    expect((await automationRow(daily.id)).nextRunAt?.toISOString()).toBe("2026-01-16T07:00:00.000Z");
    // The same check again (or a second worker a moment later): nothing new.
    await scheduler.tick();
    expect(await tasksOf(daily.id)).toHaveLength(1);

    // The first task finishes; the next day's run starts its own task.
    await db.update(tasks).set({ status: "completed" }).where(eq(tasks.automationId, daily.id));
    setNow("2026-01-16T07:00:10Z");
    await scheduler.tick();
    expect(await tasksOf(daily.id)).toHaveLength(2);
    expect((await automationRow(daily.id)).lastRunAt?.toISOString()).toBe("2026-01-16T07:00:00.000Z");
  });

  it("keeps 08:00 Oslo time across the switch to summer time", async () => {
    setNow("2026-03-28T12:00:00Z");
    const agent = await insertAgent(db);
    const daily = await service.create(briefing(agent.id));
    expect((await automationRow(daily.id)).nextRunAt?.toISOString()).toBe("2026-03-29T06:00:00.000Z"); // 08:00 CEST

    setNow("2026-03-29T06:00:01Z");
    await scheduler.tick();
    const [task] = await tasksOf(daily.id);
    expect(task.title).toContain("Sun 29 Mar 2026, 08:00");
    expect((await automationRow(daily.id)).nextRunAt?.toISOString()).toBe("2026-03-30T06:00:00.000Z");
  });

  it("skips and records recurring runs missed while the worker was stopped; no catch-up", async () => {
    const agent = await insertAgent(db);
    const daily = await service.create(briefing(agent.id));

    // The worker was stopped from the morning of the 15th until noon on the 18th.
    setNow("2026-01-18T11:00:00Z");
    expect(await scheduler.tick()).toEqual({ started: 0, skipped: 0, missed: 4 });

    expect(await tasksOf(daily.id)).toHaveLength(0);
    const [missed] = await occurrencesOf(daily.id);
    expect(missed).toMatchObject({ status: "missed", missedCount: 4 });
    expect(missed.scheduledFor.toISOString()).toBe("2026-01-15T07:00:00.000Z");
    expect(missed.message).toContain("Missed 4 runs from Thu 15 Jan 2026, 08:00 to Sun 18 Jan 2026, 08:00");
    expect((await automationRow(daily.id)).nextRunAt?.toISOString()).toBe("2026-01-19T07:00:00.000Z");
    expect((await service.get(daily.id)).counts).toEqual({ started: 0, missed: 4, skipped: 0 });
  });

  it("starts a run that is only a little late (a restart within the grace period)", async () => {
    const agent = await insertAgent(db);
    const daily = await service.create(briefing(agent.id));
    // The worker restarted and checked 3 minutes after 08:00.
    setNow("2026-01-15T07:03:00Z");
    await schedulerWith().tick(); // a new scheduler instance: state lives in PostgreSQL
    expect(await tasksOf(daily.id)).toHaveLength(1);
    expect(await occurrencesOf(daily.id)).toMatchObject([{ status: "started" }]);
  });

  it("marks a missed one-time run visibly, and lets the owner run it explicitly", async () => {
    const agent = await insertAgent(db);
    const once = await service.create(briefing(agent.id, { name: "One-off", schedule: { kind: "once", date: "2026-01-15", time: "09:00" } }));
    setNow("2026-01-15T10:00:00Z");
    await scheduler.tick();

    expect(await tasksOf(once.id)).toHaveLength(0);
    const detail = await service.get(once.id);
    expect(detail.state).toBe("missed");
    expect(detail.history[0]).toMatchObject({ status: "missed" });
    expect(detail.history[0].message).toContain("use Run now or choose a new time");

    const { taskId } = await service.runNow(once.id);
    expect((await tasksOf(once.id)).map((t) => t.id)).toEqual([taskId]);
    expect((await service.get(once.id)).history[0]).toMatchObject({ trigger: "manual", status: "started" });
  });

  it("never enqueues a paused automation", async () => {
    const agent = await insertAgent(db);
    const daily = await service.create(briefing(agent.id));
    await service.setEnabled(daily.id, false);
    setNow("2026-01-15T07:00:01Z");
    expect(await scheduler.tick()).toEqual({ started: 0, skipped: 0, missed: 0 });
    expect(await tasksOf(daily.id)).toHaveLength(0);
  });

  it("skips a run whose agent has been disabled, records why, and keeps the schedule", async () => {
    const agent = await insertAgent(db, { name: "Research Assistant" });
    const daily = await service.create(briefing(agent.id));
    await db.update(agents).set({ enabled: false }).where(eq(agents.id, agent.id));

    setNow("2026-01-15T07:00:01Z");
    expect(await scheduler.tick()).toEqual({ started: 0, skipped: 1, missed: 0 });
    expect(await tasksOf(daily.id)).toHaveLength(0);
    expect(await occurrencesOf(daily.id)).toMatchObject([
      { status: "skipped", reason: "agent_unavailable", message: expect.stringContaining("“Research Assistant” is disabled") },
    ]);
    expect((await automationRow(daily.id)).nextRunAt?.toISOString()).toBe("2026-01-16T07:00:00.000Z");
    await expect(service.runNow(daily.id)).rejects.toMatchObject({ code: "cannot_start" });
  });

  it("never overlaps: a run is skipped while the previous one is still going", async () => {
    const agent = await insertAgent(db);
    const hourly = await service.create(briefing(agent.id, { schedule: { kind: "interval", every: 1, unit: "hours" } }));
    setNow("2026-01-15T07:00:00Z");
    await scheduler.tick();
    const [first] = await tasksOf(hourly.id);
    await db.update(tasks).set({ status: "awaiting_approval" }).where(eq(tasks.id, first.id));

    setNow("2026-01-15T08:00:00Z");
    expect(await scheduler.tick()).toEqual({ started: 0, skipped: 1, missed: 0 });
    expect((await occurrencesOf(hourly.id)).at(-1)).toMatchObject({ status: "skipped", reason: "overlap" });
    await expect(service.runNow(hourly.id)).rejects.toMatchObject({
      message: expect.stringContaining("previous run of this automation hadn’t finished"),
    });
  });

  it("respects the cap on concurrent automation tasks and on runs per day", async () => {
    const agent = await insertAgent(db);
    const a = await service.create(briefing(agent.id, { name: "A" }));
    const b = await service.create(briefing(agent.id, { name: "B" }));
    setNow("2026-01-15T07:00:01Z");
    expect(await schedulerWith({ maxConcurrentExecutions: 1 }).tick()).toEqual({ started: 1, skipped: 1, missed: 0 });
    const reasons = [...(await occurrencesOf(a.id)), ...(await occurrencesOf(b.id))].map((o) => o.reason);
    expect(reasons).toContain("concurrency_limit");

    // The started task finished; the daily cap of 1 still holds for the rest of the day.
    await db.update(tasks).set({ status: "completed" });
    await db.update(automations).set({ nextRunAt: new Date("2026-01-15T07:00:00Z") }).where(eq(automations.id, b.id));
    await db.delete(automationOccurrences).where(eq(automationOccurrences.automationId, b.id));
    expect(await schedulerWith({ maxRunsPerDay: 1 }).tick()).toEqual({ started: 0, skipped: 1, missed: 0 });
    expect(await occurrencesOf(b.id)).toMatchObject([{ reason: "daily_limit" }]);
  });

  it("creates exactly one task when several workers check at the same moment", async () => {
    const agent = await insertAgent(db);
    const created = await Promise.all(
      ["A", "B", "C"].map((name) => service.create(briefing(agent.id, { name }))),
    );
    setNow("2026-01-15T07:00:01Z");
    // Five schedulers (as in five worker processes) race over the same three due automations.
    const results = await Promise.all(Array.from({ length: 5 }, () => schedulerWith().tick()));
    expect(results.reduce((sum, r) => sum + r.started, 0)).toBe(3);
    for (const automation of created) {
      expect(await tasksOf(automation.id)).toHaveLength(1);
      expect(await occurrencesOf(automation.id)).toHaveLength(1);
    }
  });

  it("refuses a second record of the same run, even if next_run_at is wound back", async () => {
    const agent = await insertAgent(db);
    const daily = await service.create(briefing(agent.id));
    setNow("2026-01-15T07:00:01Z");
    await scheduler.tick();
    await db.update(tasks).set({ status: "completed" });

    // As if a crash left the old time in place: the occurrence ID (automation, 08:00) already exists.
    await db.update(automations).set({ nextRunAt: new Date("2026-01-15T07:00:00Z") }).where(eq(automations.id, daily.id));
    expect(await scheduler.tick()).toEqual({ started: 0, skipped: 0, missed: 0 });
    expect(await tasksOf(daily.id)).toHaveLength(1);
    await expect(
      db.insert(automationOccurrences).values({
        automationId: daily.id,
        scheduledFor: new Date("2026-01-15T07:00:00Z"),
        status: "started",
        message: "duplicate",
      }),
    ).rejects.toThrow();
  });
});

describe("scheduled tasks run through the normal engine", () => {
  async function dueTask(agentOverrides: Partial<typeof agents.$inferInsert> = {}) {
    const agent = await insertAgent(db, { name: "Research Assistant", ...agentOverrides });
    const automation = await service.create(briefing(agent.id));
    setNow("2026-01-15T07:00:01Z");
    await scheduler.tick();
    const [task] = await tasksOf(automation.id);
    return { agent, automation, task };
  }

  it("executes the task, saves the result, and shows it in the automation's history", async () => {
    const { automation, task } = await dueTask();
    const { executor, inputs } = worker(async () =>
      answer("Verified: nothing could be checked without web access. Unverified: none reported."),
    );
    expect(await executor.runOnce()).toBe(true);

    expect(inputs[0].prompt).toContain(BRIEFING);
    const [done] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(done).toMatchObject({ status: "completed", automationId: automation.id });
    const detail = await service.get(automation.id);
    expect(detail.history[0].task).toMatchObject({ id: task.id, status: "completed" });
    expect(detail.latestResult).toMatchObject({ taskId: task.id, result: expect.stringContaining("Verified") });
    expect(detail.hasActiveRun).toBe(false);
  });

  it("gives the agent only its own tools, and refuses one that isn't enabled", async () => {
    const { agent, task } = await dueTask();
    await db.insert(agentToolPermissions).values({ agentId: agent.id, toolId: "send_note", mode: "allow" });
    const { executor, inputs } = worker(async (input) => {
      // The permission is removed while the scheduled task runs.
      await db.delete(agentToolPermissions).where(eq(agentToolPermissions.agentId, agent.id));
      const outcome = await input.tools[0].invoke({ text: "hi" });
      return answer(outcome.isError ? "Refused." : "Sent.");
    });
    await executor.runOnce();

    expect(inputs[0].tools.map((tool) => tool.name)).toEqual(["send_note"]);
    expect(toolRuns).toEqual([]);
    const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id));
    expect(events.map((e) => e.type)).toContain("tool_denied");
    expect(await db.select().from(toolCalls)).toMatchObject([{ status: "denied" }]);
  });

  it("waits for the owner's approval, and never runs an action whose request expired", async () => {
    const { agent, task } = await dueTask();
    await db.insert(agentToolPermissions).values({ agentId: agent.id, toolId: "send_note", mode: "ask" });
    const { executor } = worker(async (input) => {
      const outcome = await input.tools[0].invoke({ text: "to the team" });
      return answer(outcome.isError ? "Not sent." : "Sent.");
    }, 300);
    const execution = executor.runOnce();
    await waitFor(async () => (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0].status === "awaiting_approval");
    const [call] = await db.select().from(toolCalls);
    expect(call).toMatchObject({ status: "awaiting_approval", requiresApproval: true });

    // Nobody approves (it's 08:00 and the owner is asleep): it expires and never runs.
    await execution;
    expect(toolRuns).toEqual([]);
    expect((await db.select().from(toolCalls))[0].status).toBe("expired");
    await expect(conversations.decideToolCall(call.id, "approve")).rejects.toBeTruthy();
  });

  it("a Claude usage limit fails the task without retrying, and pauses scheduled runs for a while", async () => {
    const agent = await insertAgent(db);
    const hourly = await service.create(briefing(agent.id, { schedule: { kind: "interval", every: 1, unit: "hours" } }));
    setNow("2026-01-15T07:00:01Z");
    await scheduler.tick();
    const { executor } = worker(async () => ({
      status: "failed",
      code: "usage_limit",
      message: "You’ve reached your Claude usage limit. Try again after it resets.",
    }));
    await executor.runOnce();

    const [task] = await tasksOf(hourly.id);
    expect(task).toMatchObject({ status: "failed", errorCode: "usage_limit" });
    expect(await db.select().from(runs).where(eq(runs.taskId, task.id))).toHaveLength(1); // no retry

    // The failure was 40 minutes before the next run (on the controlled clock):
    // that run is skipped instead of hitting the limit again…
    const failedAt = (iso: string) => db.update(runs).set({ finishedAt: new Date(iso) }).where(eq(runs.taskId, task.id));
    await failedAt("2026-01-15T07:20:00Z");
    setNow("2026-01-15T08:00:01Z");
    expect(await scheduler.tick()).toEqual({ started: 0, skipped: 1, missed: 0 });
    expect((await occurrencesOf(hourly.id)).at(-1)).toMatchObject({ status: "skipped", reason: "usage_limit" });
    await expect(service.runNow(hourly.id)).rejects.toMatchObject({ message: expect.stringContaining("usage limit") });

    // …and runs start again once the cooldown (60 minutes) has passed.
    setNow("2026-01-15T09:00:01Z");
    expect(await scheduler.tick()).toMatchObject({ started: 1 });
  });

  it("survives a worker restart: an attempt lost mid-run is recovered by the normal task policy", async () => {
    const { task } = await dueTask();
    // Worker 1 claimed the run, then died (its heartbeat is old).
    await db
      .update(runs)
      .set({ status: "running", workerId: "dead-worker", startedAt: sql`now()`, heartbeatAt: sql`now() - interval '5 minutes'` })
      .where(eq(runs.taskId, task.id));
    await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, task.id));

    const { executor } = worker(async () => answer("Done after restart."));
    expect(await executor.recoverStaleRuns()).toBe(1);
    await db.update(runs).set({ notBefore: sql`now()` }).where(eq(runs.taskId, task.id));
    expect(await executor.runOnce()).toBe(true);
    const attempts = await db.select().from(runs).where(eq(runs.taskId, task.id)).orderBy(asc(runs.attempt));
    expect(attempts.map((r) => [r.attempt, r.status])).toEqual([
      [1, "failed"],
      [2, "completed"],
    ]);
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0].result).toBe("Done after restart.");
  });
});
