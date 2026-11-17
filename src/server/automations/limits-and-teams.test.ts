import { asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AUTOMATION_LIMITS } from "@/lib/automations/limits";
import { closeDatabase, createDatabase } from "@/server/db/client";
import {
  agentDelegationTargets,
  agents,
  agentToolPermissions,
  automationOccurrences,
  automations,
  notifications,
  taskEvents,
  tasks,
  teamMembers,
  teams,
} from "@/server/db/schema";
import type { Logger } from "@/server/logger";
import { syncNotifications } from "@/server/notifications/sync";
import { RUN_LIMITS } from "@/server/runs/config";
import { createRunExecutor, type ExecutorLimits } from "@/server/runs/executor";
import { fakeRuntime, insertAgent, testProviders, untilAborted } from "@/server/runs/test-helpers";
import type { RunInput, RunResult } from "@/server/runtime/types";
import { createTeamService } from "@/server/teams/service";
import { createToolInvoker } from "@/server/tools/invoker";
import { createToolRegistry } from "@/server/tools/registry";
import { createScheduler } from "./scheduler";
import { createAutomationService } from "./service";

// M6B on the backend, against the test database: per-automation limits (and
// that the global ones stay hard upper bounds), pausing after repeated
// failures, and automations that run through a team's coordinator. A
// controlled clock replaces waiting; a fake runtime replaces Claude.

const db = createDatabase(process.env.TEST_DATABASE_URL!);
const silentLog: Logger = () => {};
const OSLO = "Europe/Oslo";

let now = new Date("2026-01-15T06:00:00Z");
const clock = () => now;
const setNow = (iso: string) => (now = new Date(iso));

const limits = { ...AUTOMATION_LIMITS, maxRunsPerDay: 100, maxConcurrentExecutions: 5 };
const service = createAutomationService({ db, providers: testProviders, limits, clock });
const schedulerWith = (overrides: Partial<typeof limits> = {}) =>
  createScheduler({ db, providers: testProviders, log: silentLog, limits: { ...limits, ...overrides }, clock });
const scheduler = schedulerWith();
const teamService = createTeamService({ db, providers: testProviders });

const HOURLY = { kind: "interval", every: 1, unit: "hours" } as const;

function input(extra: Record<string, unknown> = {}) {
  return {
    name: "Daily AI Research Briefing",
    instructions: "Summarize the latest developments in AI.",
    schedule: HOURLY,
    timeZone: OSLO,
    ...extra,
  };
}
const forAgent = (agentId: string, extra: Record<string, unknown> = {}) => input({ agentId, ...extra });
const forTeam = (teamId: string, extra: Record<string, unknown> = {}) => input({ targetKind: "team", teamId, ...extra });

const tasksOf = (id: string) => db.select().from(tasks).where(eq(tasks.automationId, id)).orderBy(asc(tasks.createdAt));
const occurrencesOf = (id: string) =>
  db.select().from(automationOccurrences).where(eq(automationOccurrences.automationId, id)).orderBy(asc(automationOccurrences.scheduledFor));
const rowOf = async (id: string) => (await db.select().from(automations).where(eq(automations.id, id)))[0];

/** Moves the clock one hour at a time and ticks: each tick is one due run. */
async function tickHours(count: number, from = "2026-01-15T07:00:01Z") {
  setNow(from);
  const results = [];
  for (let i = 0; i < count; i++) {
    results.push(await scheduler.tick());
    now = new Date(now.getTime() + 3_600_000);
  }
  return results;
}

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
function worker(behave: (input: RunInput, signal: AbortSignal) => Promise<RunResult>, overrides: Partial<ExecutorLimits> = {}) {
  const { runtime, inputs } = fakeRuntime(behave);
  const executor = createRunExecutor({
    db,
    providers: testProviders,
    runtimes: [runtime],
    log: silentLog,
    tools: createToolInvoker({
      db,
      registry: createToolRegistry([]),
      log: silentLog,
      limits: { approvalTtlMs: 5_000, approvalPollMs: 10 },
      workspaceFor: async () => "/nonexistent",
    }),
    isReadOnlyTool: () => true,
    workerId: "test-worker",
    limits: { ...executorLimits, ...overrides },
  });
  return { executor, inputs };
}
const answer = (text: string): RunResult => ({ status: "completed", text, usage: { inputTokens: 1, outputTokens: 1 } });

async function failedTaskFor(automationId: string, agentId: string, at: string) {
  await db.insert(tasks).values({
    agentId,
    automationId,
    title: "run",
    instructions: "x",
    status: "failed",
    errorCode: "timeout",
    errorMessage: "Stopped.",
    createdAt: new Date(at),
    finishedAt: new Date(at),
  });
}

beforeEach(async () => {
  await db.delete(notifications);
  await db.delete(automations); // team automations survive an agent delete, and block a team delete
  await db.delete(teams);
  await db.delete(agents);
  setNow("2026-01-15T06:00:00Z");
});

afterAll(async () => {
  await db.delete(automations);
  await closeDatabase(db);
});

describe("per-automation limits: validation", () => {
  it("stores the limits, with safe defaults when none are given", async () => {
    const agent = await insertAgent(db);
    const plain = await service.create(forAgent(agent.id));
    expect(plain).toMatchObject({ maxRunsPerDay: null, maxDurationMs: null, allowOverlap: false, pauseAfterFailures: null });

    const limited = await service.create(
      forAgent(agent.id, { name: "Limited", maxRunsPerDay: 2, maxDurationMinutes: 5, allowOverlap: true, pauseAfterFailures: 3 }),
    );
    expect(await rowOf(limited.id)).toMatchObject({ maxRunsPerDay: 2, maxDurationMs: 300_000, allowOverlap: true, pauseAfterFailures: 3 });
  });

  it("never accepts a limit looser than the global one", async () => {
    const agent = await insertAgent(db);
    const attempt = (extra: Record<string, unknown>) => service.create(forAgent(agent.id, extra));
    await expect(attempt({ maxRunsPerDay: AUTOMATION_LIMITS.maxRunsPerDay + 1 })).rejects.toMatchObject({
      code: "validation_failed",
      fieldErrors: { maxRunsPerDay: [expect.any(String)] },
    });
    await expect(attempt({ maxDurationMinutes: AUTOMATION_LIMITS.maxDurationMs / 60_000 + 1 })).rejects.toMatchObject({
      code: "validation_failed",
      fieldErrors: { maxDurationMinutes: [expect.any(String)] },
    });
    await expect(attempt({ maxRunsPerDay: 0 })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(attempt({ maxDurationMinutes: 0 })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(attempt({ pauseAfterFailures: AUTOMATION_LIMITS.maxPauseAfterFailures + 1 })).rejects.toMatchObject({
      code: "validation_failed",
    });
    // Exactly the global limit is fine ("equally restrictive").
    await expect(
      attempt({ maxRunsPerDay: AUTOMATION_LIMITS.maxRunsPerDay, maxDurationMinutes: AUTOMATION_LIMITS.maxDurationMs / 60_000 }),
    ).resolves.toBeTruthy();
  });

  it("the global task timeout the worker uses equals the largest duration an automation may ask for", () => {
    expect(AUTOMATION_LIMITS.maxDurationMs).toBe(RUN_LIMITS.taskTimeoutMs);
  });

  it("the database refuses limits that were never valid, even if the service were bypassed", async () => {
    const agent = await insertAgent(db);
    const created = await service.create(forAgent(agent.id));
    await expect(db.update(automations).set({ maxRunsPerDay: 0 }).where(eq(automations.id, created.id))).rejects.toBeTruthy();
    await expect(db.update(automations).set({ maxDurationMs: 1_000 }).where(eq(automations.id, created.id))).rejects.toBeTruthy();
  });
});

describe("per-automation limits: enforcement", () => {
  it("stops a run that would exceed the automation's daily cap, and records why", async () => {
    const agent = await insertAgent(db);
    const created = await service.create(forAgent(agent.id, { maxRunsPerDay: 2, allowOverlap: true }));
    const results = await tickHours(3);
    expect(results.map((r) => r.started)).toEqual([1, 1, 0]);

    const occurrences = await occurrencesOf(created.id);
    expect(occurrences.map((o) => o.status)).toEqual(["started", "started", "skipped"]);
    expect(occurrences[2]).toMatchObject({ reason: "automation_daily_limit" });
    expect(occurrences[2].message).toContain("its limit is 2");
    expect(await tasksOf(created.id)).toHaveLength(2);
  });

  it("another automation's runs don't count against this one's cap", async () => {
    const agent = await insertAgent(db);
    const capped = await service.create(forAgent(agent.id, { name: "A", maxRunsPerDay: 1, allowOverlap: true }));
    const other = await service.create(forAgent(agent.id, { name: "B", allowOverlap: true }));
    await tickHours(2);
    expect(await tasksOf(capped.id)).toHaveLength(1);
    expect(await tasksOf(other.id)).toHaveLength(2);
  });

  it("skips a run while the previous one is unfinished, unless overlap is allowed", async () => {
    const agent = await insertAgent(db);
    const strict = await service.create(forAgent(agent.id, { name: "Strict" }));
    const loose = await service.create(forAgent(agent.id, { name: "Loose", allowOverlap: true }));
    await tickHours(2);

    expect((await occurrencesOf(strict.id)).map((o) => o.reason)).toEqual([null, "overlap"]);
    expect(await tasksOf(strict.id)).toHaveLength(1);
    expect(await tasksOf(loose.id)).toHaveLength(2);
  });

  it("still applies the global caps to an automation that allows overlap", async () => {
    const agent = await insertAgent(db);
    const loose = await service.create(forAgent(agent.id, { allowOverlap: true }));
    setNow("2026-01-15T07:00:01Z");
    const tight = schedulerWith({ maxConcurrentExecutions: 1 });
    await tight.tick();
    now = new Date(now.getTime() + 3_600_000);
    await tight.tick();
    expect((await occurrencesOf(loose.id)).map((o) => o.reason)).toEqual([null, "concurrency_limit"]);
  });

  it("treats the global daily limit as an upper bound even if a row holds a looser value", async () => {
    const agent = await insertAgent(db);
    const created = await service.create(forAgent(agent.id, { maxRunsPerDay: 5, allowOverlap: true }));
    await db.update(automations).set({ maxRunsPerDay: 1_000 }).where(eq(automations.id, created.id)); // hand-edited
    setNow("2026-01-15T07:00:01Z");
    const strictGlobal = schedulerWith({ maxRunsPerDay: 2 });
    for (let i = 0; i < 3; i++) {
      await strictGlobal.tick();
      now = new Date(now.getTime() + 3_600_000);
    }
    expect(await tasksOf(created.id)).toHaveLength(2);
    expect((await occurrencesOf(created.id)).at(-1)?.message).toContain("its limit is 2");
  });

  it("gives the task its duration limit, and the worker stops an attempt that runs longer", async () => {
    const agent = await insertAgent(db);
    const created = await service.create(forAgent(agent.id, { maxDurationMinutes: 3 }));
    await tickHours(1);
    const [task] = await tasksOf(created.id);
    expect(task.maxDurationMs).toBe(180_000);

    // The test shrinks the stored limit to 50 ms; the executor's own limit is 5 s.
    await db.update(tasks).set({ maxDurationMs: 50 }).where(eq(tasks.id, task.id));
    const { executor } = worker((_input, signal) => untilAborted(signal));
    const started = Date.now();
    await executor.runOnce();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((await tasksOf(created.id))[0]).toMatchObject({ status: "failed", errorCode: "timeout" });
  });

  it("never lets a task run longer than the worker's own limit", async () => {
    const agent = await insertAgent(db);
    const created = await service.create(forAgent(agent.id));
    await tickHours(1);
    const [task] = await tasksOf(created.id);
    await db.update(tasks).set({ maxDurationMs: 600_000 }).where(eq(tasks.id, task.id)); // hand-edited, looser
    const { executor } = worker((_input, signal) => untilAborted(signal), { taskTimeoutMs: 80 });
    await executor.runOnce();
    expect((await tasksOf(created.id))[0]).toMatchObject({ status: "failed", errorCode: "timeout" });
  });

  it("a task without a duration limit uses the worker's limit", async () => {
    const agent = await insertAgent(db);
    const created = await service.create(forAgent(agent.id));
    await tickHours(1);
    expect((await tasksOf(created.id))[0].maxDurationMs).toBeNull();
    const { executor } = worker(async () => answer("done"));
    await executor.runOnce();
    expect((await tasksOf(created.id))[0].status).toBe("completed");
  });
});

describe("pausing after repeated failures", () => {
  it("pauses the automation instead of starting another run, records why, and notifies", async () => {
    const agent = await insertAgent(db);
    const created = await service.create(forAgent(agent.id, { pauseAfterFailures: 2 }));
    await failedTaskFor(created.id, agent.id, "2026-01-15T05:00:00Z");
    await failedTaskFor(created.id, agent.id, "2026-01-15T06:00:00Z");

    setNow("2026-01-15T07:00:01Z");
    expect(await scheduler.tick()).toEqual({ started: 0, skipped: 1, missed: 0 });

    const row = await rowOf(created.id);
    expect(row).toMatchObject({ enabled: false, nextRunAt: null });
    expect(row.pausedReason).toContain("failed in a row");
    expect((await occurrencesOf(created.id)).at(-1)).toMatchObject({ status: "skipped", reason: "paused_after_failures" });
    expect((await service.get(created.id)).state).toBe("paused");
    expect((await service.list())[0].pausedReason).toBe(row.pausedReason);

    await syncNotifications(db);
    expect(await db.select().from(notifications)).toMatchObject([{ kind: "automation_paused", automationId: created.id }]);

    // Nothing more is scheduled while it is paused.
    setNow("2026-01-15T09:00:00Z");
    expect(await scheduler.tick()).toEqual({ started: 0, skipped: 0, missed: 0 });
  });

  it("does not pause when a run in between succeeded, or too few failed, or the setting is off", async () => {
    const agent = await insertAgent(db);
    const mixed = await service.create(forAgent(agent.id, { name: "Mixed", pauseAfterFailures: 2 }));
    await failedTaskFor(mixed.id, agent.id, "2026-01-15T04:00:00Z");
    await db.insert(tasks).values({ agentId: agent.id, automationId: mixed.id, title: "ok", instructions: "x", status: "completed", createdAt: new Date("2026-01-15T05:00:00Z") });
    await failedTaskFor(mixed.id, agent.id, "2026-01-15T06:00:00Z");
    const off = await service.create(forAgent(agent.id, { name: "Off" }));
    for (const at of ["2026-01-15T04:00:00Z", "2026-01-15T05:00:00Z", "2026-01-15T06:00:00Z"]) await failedTaskFor(off.id, agent.id, at);

    setNow("2026-01-15T07:00:01Z");
    expect(await scheduler.tick()).toMatchObject({ started: 2, skipped: 0 });
    expect(await rowOf(mixed.id)).toMatchObject({ enabled: true });
    expect(await rowOf(off.id)).toMatchObject({ enabled: true });
  });

  it("lets the owner run it by hand after the pause, and resuming clears the reason", async () => {
    const agent = await insertAgent(db);
    const created = await service.create(forAgent(agent.id, { pauseAfterFailures: 1 }));
    await failedTaskFor(created.id, agent.id, "2026-01-15T06:00:00Z");
    setNow("2026-01-15T07:00:01Z");
    await scheduler.tick();
    expect((await rowOf(created.id)).pausedReason).not.toBeNull();

    await expect(service.runNow(created.id)).resolves.toMatchObject({ taskId: expect.any(String) });
    // The manual run is still active, so resuming would only be skipped later; finish it first.
    await db.update(tasks).set({ status: "completed", finishedAt: new Date() }).where(eq(tasks.automationId, created.id));

    await service.setEnabled(created.id, true);
    expect(await rowOf(created.id)).toMatchObject({ enabled: true, pausedReason: null });
    expect((await rowOf(created.id)).nextRunAt).not.toBeNull();
  });

  it("an interrupted run counts as a failure; a cancelled one does not", async () => {
    const agent = await insertAgent(db);
    const created = await service.create(forAgent(agent.id, { pauseAfterFailures: 2 }));
    await db.insert(tasks).values({ agentId: agent.id, automationId: created.id, title: "a", instructions: "x", status: "interrupted", createdAt: new Date("2026-01-15T05:00:00Z"), finishedAt: new Date() });
    await db.insert(tasks).values({ agentId: agent.id, automationId: created.id, title: "b", instructions: "x", status: "cancelled", createdAt: new Date("2026-01-15T06:00:00Z"), finishedAt: new Date() });
    setNow("2026-01-15T07:00:01Z");
    expect(await scheduler.tick()).toMatchObject({ started: 1 });
  });
});

describe("team automations", () => {
  async function team() {
    const coordinator = await insertAgent(db, { name: "Project Manager", role: "planning" });
    const developer = await insertAgent(db, { name: "Developer", role: "engineering" });
    const created = await teamService.create({
      name: "Solas Development Team",
      memberIds: [coordinator.id, developer.id],
      coordinatorId: coordinator.id,
    });
    return { coordinator, developer, team: created };
  }

  it("creates an automation for a team, with no agent of its own", async () => {
    const { team: t, coordinator } = await team();
    const created = await service.create(forTeam(t.id));
    expect(await rowOf(created.id)).toMatchObject({ teamId: t.id, agentId: null });

    const detail = await service.get(created.id);
    expect(detail.agent).toBeNull();
    expect(detail.team).toMatchObject({ id: t.id, name: "Solas Development Team", coordinator: { id: coordinator.id, name: "Project Manager", readiness: "ready" } });
    const [summary] = await service.list();
    expect(summary.team?.coordinator?.name).toBe("Project Manager");
    expect(summary.agent).toBeNull();
  });

  it("keeps only the chosen target: a team automation drops a stray agent, and the other way round", async () => {
    const { team: t, developer } = await team();
    const asTeam = await service.create(forTeam(t.id, { agentId: developer.id }));
    expect(await rowOf(asTeam.id)).toMatchObject({ teamId: t.id, agentId: null });
    const asAgent = await service.create(forAgent(developer.id, { name: "Solo", targetKind: "agent", teamId: t.id }));
    expect(await rowOf(asAgent.id)).toMatchObject({ teamId: null, agentId: developer.id });
  });

  it("refuses a missing team, an unknown team, and a team without a coordinator", async () => {
    await expect(service.create(input({ targetKind: "team" }))).rejects.toMatchObject({ code: "validation_failed", fieldErrors: { teamId: [expect.any(String)] } });
    await expect(service.create(forTeam("0b8b6a62-5c1f-4a0e-9f0a-0a8f3a7a1111"))).rejects.toMatchObject({ code: "agent_not_found" });

    const a = await insertAgent(db, { name: "A" });
    const headless = await teamService.create({ name: "No lead", memberIds: [a.id] });
    await expect(service.create(forTeam(headless.id))).rejects.toMatchObject({
      code: "agent_unavailable",
      message: expect.stringContaining("no coordinator"),
    });
  });

  it("refuses to schedule a team whose coordinator is disabled, but can be saved paused", async () => {
    const { team: t, coordinator } = await team();
    await db.update(agents).set({ enabled: false }).where(eq(agents.id, coordinator.id));
    await expect(service.create(forTeam(t.id))).rejects.toMatchObject({ code: "agent_unavailable", message: expect.stringContaining("coordinator") });
    await expect(service.create(forTeam(t.id, { enabled: false }))).resolves.toBeTruthy();
  });

  it("starts a task for the coordinator, linked to the team, and the event says so", async () => {
    const { team: t, coordinator } = await team();
    const created = await service.create(forTeam(t.id));
    await tickHours(1);
    const [task] = await tasksOf(created.id);
    expect(task).toMatchObject({ agentId: coordinator.id, teamId: t.id, automationId: created.id, depth: 0, parentTaskId: null });
    const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id));
    expect(events.find((e) => e.type === "created")?.message).toContain("the team’s coordinator");
    // The team's page and the Tasks filter find it through the existing link.
    expect(await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.teamId, t.id))).toHaveLength(1);
  });

  it("uses whoever is coordinator when the run starts; earlier tasks keep their agent and team", async () => {
    const { team: t, coordinator, developer } = await team();
    const created = await service.create(forTeam(t.id, { allowOverlap: true }));
    await tickHours(1);
    await teamService.update(t.id, { name: t.name, memberIds: [coordinator.id, developer.id], coordinatorId: developer.id });
    await tickHours(1, "2026-01-15T08:00:01Z");

    const history = await tasksOf(created.id);
    expect(history.map((task) => task.agentId)).toEqual([coordinator.id, developer.id]);
    expect(history.map((task) => task.teamId)).toEqual([t.id, t.id]);
  });

  it("skips and records the run when the coordinator is disabled, or the team has none, then recovers", async () => {
    const { team: t, coordinator, developer } = await team();
    const created = await service.create(forTeam(t.id, { allowOverlap: true }));

    await db.update(agents).set({ enabled: false }).where(eq(agents.id, coordinator.id));
    await tickHours(1);
    await teamService.update(t.id, { name: t.name, memberIds: [developer.id] }); // coordinator removed
    await tickHours(1, "2026-01-15T08:00:01Z");
    await db.update(agents).set({ enabled: true }).where(eq(agents.id, coordinator.id));
    await teamService.update(t.id, { name: t.name, memberIds: [coordinator.id, developer.id], coordinatorId: coordinator.id });
    await tickHours(1, "2026-01-15T09:00:01Z");

    const occurrences = await occurrencesOf(created.id);
    expect(occurrences.map((o) => o.reason)).toEqual(["agent_unavailable", "team_unavailable", null]);
    expect(occurrences[0].message).toContain("coordinator");
    expect(occurrences[1].message).toContain("has no coordinator");
    expect(await tasksOf(created.id)).toHaveLength(1);
    await expect(service.get(created.id)).resolves.toMatchObject({ team: { coordinator: { readiness: "ready" } } });

    await syncNotifications(db);
    expect((await db.select().from(notifications)).map((n) => n.kind)).toEqual(["automation_skipped", "automation_skipped"]);
  });

  it("refuses Run now when nobody can work, with the reason", async () => {
    const { team: t, developer } = await team();
    const created = await service.create(forTeam(t.id));
    await teamService.update(t.id, { name: t.name, memberIds: [developer.id] });
    await expect(service.runNow(created.id)).rejects.toMatchObject({ code: "cannot_start", message: expect.stringContaining("no coordinator") });
  });

  it("grants no permissions: members get no tools or delegation targets, and the coordinator runs with only its own", async () => {
    const { team: t, coordinator } = await team();
    const toolsBefore = await db.select().from(agentToolPermissions);
    const targetsBefore = await db.select().from(agentDelegationTargets);

    const created = await service.create(forTeam(t.id));
    await tickHours(1);
    const { executor, inputs } = worker(async () => answer("done"));
    await executor.runOnce();

    expect((await tasksOf(created.id))[0]).toMatchObject({ status: "completed", agentId: coordinator.id });
    expect(inputs[0].tools).toEqual([]); // the coordinator has no tools and no delegation targets
    expect(await db.select().from(agentToolPermissions)).toEqual(toolsBefore);
    expect(await db.select().from(agentDelegationTargets)).toEqual(targetsBefore);
    expect(await db.select().from(tasks).where(eq(tasks.depth, 1))).toEqual([]); // nothing delegated
  });

  it("can't delete a team that automations run through, and keeps its tasks' team link", async () => {
    const { team: t, coordinator } = await team();
    const created = await service.create(forTeam(t.id));
    await tickHours(1);
    await expect(teamService.remove(t.id)).rejects.toMatchObject({ message: expect.stringContaining("1 automation") });
    expect((await tasksOf(created.id))[0].teamId).toBe(t.id);

    // Removing the coordinator from the team changes who runs next, not the past.
    await teamService.update(t.id, { name: t.name, memberIds: [] });
    expect((await tasksOf(created.id))[0]).toMatchObject({ teamId: t.id, agentId: coordinator.id });
    expect(await db.select().from(teamMembers).where(eq(teamMembers.teamId, t.id))).toEqual([]);

    await service.remove(created.id);
    await expect(teamService.remove(t.id)).resolves.toBeUndefined();
  });

  it("two schedulers racing for one due team run create one task", async () => {
    const { team: t } = await team();
    const created = await service.create(forTeam(t.id));
    setNow("2026-01-15T07:00:01Z");
    await Promise.all([scheduler.tick(), schedulerWith().tick(), schedulerWith().tick()]);
    expect(await tasksOf(created.id)).toHaveLength(1);
    expect(await occurrencesOf(created.id)).toHaveLength(1);
  });
});

describe("restart safety", () => {
  it("a worker that was down records one missed period and starts no catch-up task; pause state survives", async () => {
    const agent = await insertAgent(db);
    const created = await service.create(forAgent(agent.id, { pauseAfterFailures: 3 }));
    setNow("2026-01-15T12:00:00Z"); // five hours of downtime: 07:00 to 11:00 are missed, 12:00 starts
    expect(await scheduler.tick()).toMatchObject({ started: 1, missed: 5 });
    expect(await tasksOf(created.id)).toHaveLength(1);
    // A second process picking up afterwards creates nothing for the same period.
    expect(await schedulerWith().tick()).toEqual({ started: 0, skipped: 0, missed: 0 });
  });
});
