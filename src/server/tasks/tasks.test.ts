import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createConversationService } from "@/server/conversations/service";
import { closeDatabase, createDatabase } from "@/server/db/client";
import { agents, agentToolPermissions, runs, taskEvents, tasks, toolCalls } from "@/server/db/schema";
import type { Logger } from "@/server/logger";
import { createRunExecutor, type ExecutorLimits } from "@/server/runs/executor";
import { buildTaskPrompt } from "@/server/runs/prompt";
import { fakeRuntime, insertAgent, testProviders, untilAborted } from "@/server/runs/test-helpers";
import { runWorkerLoop } from "@/server/runs/worker-loop";
import type { RunInput, RunResult } from "@/server/runtime/types";
import { createToolInvoker } from "@/server/tools/invoker";
import { createToolRegistry } from "@/server/tools/registry";
import type { AnyToolDefinition } from "@/server/tools/types";
import { TaskServiceError } from "./errors";
import { createTaskService } from "./service";

// Background tasks end to end on the backend: the web side (task service)
// and the worker side (run executor), against the test database, with a fake
// runtime in place of Claude. Nothing here calls the real Claude service.

const db = createDatabase(process.env.TEST_DATABASE_URL!);
const service = createTaskService({ db, providers: testProviders, limits: { taskAutoRetries: 1 } });
const conversations = createConversationService({ db, providers: testProviders });
const silentLog: Logger = () => {};
const limits: ExecutorLimits = {
  timeoutMs: 5_000,
  taskTimeoutMs: 5_000,
  retryBackoffMs: 1_000,
  heartbeatMs: 20,
  staleAfterMs: 30_000,
  progressWriteMs: 10,
  historyMessages: 20,
  historyCharacters: 60_000,
};

const answer = (text: string): RunResult => ({ status: "completed", text, usage: { inputTokens: 10, outputTokens: 5 } });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `check` returns something truthy, or fails after `timeoutMs`. */
async function waitFor<T>(check: () => Promise<T | undefined | null | false>, timeoutMs = 3_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await sleep(10);
  }
  throw new Error("Timed out waiting for a condition.");
}

// Tools for these tests: one read-only, one that "changes something".
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
const invoker = createToolInvoker({
  db,
  registry,
  log: silentLog,
  limits: { approvalTtlMs: 5_000, approvalPollMs: 10 },
  workspaceFor: async () => "/nonexistent",
});

function worker(
  behave: (input: RunInput, signal: AbortSignal) => Promise<RunResult>,
  overrides: Partial<ExecutorLimits> = {},
  options: { invokerLimits?: { approvalTtlMs: number; approvalPollMs: number } } = {},
) {
  const { runtime, inputs } = fakeRuntime(behave);
  const tools = options.invokerLimits
    ? createToolInvoker({ db, registry, log: silentLog, limits: options.invokerLimits, workspaceFor: async () => "/x" })
    : invoker;
  const executor = createRunExecutor({
    db,
    providers: testProviders,
    runtimes: [runtime],
    log: silentLog,
    tools,
    isReadOnlyTool: (id) => registry.get(id)?.sideEffects === false,
    workerId: "test-worker",
    limits: { ...limits, ...overrides },
  });
  return { executor, inputs };
}

/** A runtime that signals when it starts (after using a tool, if asked), then waits to be aborted. */
function blocking(useTool?: { name: string; text: string }) {
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  const behave = async (input: RunInput, signal: AbortSignal) => {
    if (useTool) await input.tools.find((tool) => tool.name === useTool.name)!.invoke({ text: useTool.text });
    started();
    return untilAborted(signal);
  };
  return { behave, running };
}

async function taskRow(id: string) {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  return row;
}
async function runsOf(taskId: string) {
  return db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(asc(runs.attempt));
}
async function eventTypes(taskId: string) {
  const rows = await db.select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).orderBy(asc(taskEvents.id));
  return rows.map((row) => row.type);
}
/** Makes a scheduled retry due now, instead of waiting for its backoff. */
async function makeDue(taskId: string) {
  await db.update(runs).set({ notBefore: sql`now()` }).where(eq(runs.taskId, taskId));
}
const newTask = (agentId: string, extra: Record<string, unknown> = {}) =>
  service.create({
    agentId,
    title: "Research AI Agent Architectures",
    instructions: "Explain the difference between a chatbot, a tool-using agent, and a multi-agent system.",
    ...extra,
  });

beforeEach(async () => {
  toolRuns = [];
  await db.delete(agents); // cascades to tasks, runs, events, and tool calls
});

afterAll(async () => {
  await closeDatabase(db);
});

describe("creating a task", () => {
  it("saves the task as queued with its first attempt waiting for the worker", async () => {
    const agent = await insertAgent(db);
    const { taskId } = await newTask(agent.id);

    const task = await taskRow(taskId);
    expect(task).toMatchObject({ status: "queued", agentId: agent.id, title: "Research AI Agent Architectures" });
    expect(await runsOf(taskId)).toMatchObject([{ status: "pending", attempt: 1, conversationId: null, agentId: agent.id }]);
    expect(await eventTypes(taskId)).toEqual(["created", "queued"]);
  });

  it("rejects invalid input with field errors, and unknown fields", async () => {
    const agent = await insertAgent(db);
    const attempts = [
      { agentId: agent.id, title: "  ", instructions: "Do it." },
      { agentId: agent.id, title: "Ok", instructions: "" },
      { agentId: agent.id, title: "x".repeat(121), instructions: "Do it." },
      { agentId: agent.id, title: "Ok", instructions: "x".repeat(20_001) },
      { agentId: "not-a-uuid", title: "Ok", instructions: "Do it." },
      { agentId: agent.id, title: "Ok", instructions: "Do it.", status: "completed" },
    ];
    for (const input of attempts) {
      await expect(service.create(input)).rejects.toMatchObject({ code: "validation_failed" });
    }
    await expect(service.create({ agentId: agent.id, title: "", instructions: "Do it." })).rejects.toMatchObject({
      fieldErrors: { title: ["Give the task a title."] },
    });
    expect(await db.select().from(tasks)).toHaveLength(0);
  });

  it("rejects an agent that doesn't exist, is disabled, or has no model", async () => {
    await expect(newTask(crypto.randomUUID())).rejects.toMatchObject({ code: "agent_not_found" });
    const disabled = await insertAgent(db, { name: "Off", enabled: false });
    await expect(newTask(disabled.id)).rejects.toMatchObject({ code: "agent_unavailable" });
    const unconfigured = await insertAgent(db, { name: "No model", providerId: null, modelId: null });
    await expect(newTask(unconfigured.id)).rejects.toMatchObject({ code: "agent_unavailable" });
    expect(await db.select().from(tasks)).toHaveLength(0);
  });

  it("creates one task for a repeated submit, even when both arrive at once", async () => {
    const agent = await insertAgent(db);
    const clientRequestId = crypto.randomUUID();
    const first = await newTask(agent.id, { clientRequestId });
    const again = await newTask(agent.id, { clientRequestId });
    expect(again).toEqual(first);

    const racing = crypto.randomUUID();
    const results = await Promise.all([newTask(agent.id, { clientRequestId: racing }), newTask(agent.id, { clientRequestId: racing })]);
    expect(results[0]).toEqual(results[1]);
    expect(await db.select().from(tasks)).toHaveLength(2);
    expect(await db.select().from(runs)).toHaveLength(2);
  });
});

describe("the worker runs a task", () => {
  it("claims it, runs the agent with the task's words, and saves the real result", async () => {
    const agent = await insertAgent(db, { instructions: "Write like a careful researcher." });
    const { taskId } = await newTask(agent.id);
    let statusWhileRunning: string | undefined;
    const { executor, inputs } = worker(async () => {
      statusWhileRunning = (await taskRow(taskId)).status;
      return answer("A chatbot replies; an agent acts with tools; a multi-agent system splits the work.");
    });

    expect(await executor.runOnce()).toBe(true);

    expect(statusWhileRunning).toBe("running");
    expect(inputs[0].prompt).toBe(
      buildTaskPrompt(
        "Research AI Agent Architectures",
        "Explain the difference between a chatbot, a tool-using agent, and a multi-agent system.",
      ),
    );
    expect(inputs[0].systemPrompt).toContain("In this task you have no tools");
    expect(inputs[0].systemPrompt).toContain("Write like a careful researcher.");
    expect(inputs[0].model).toBe("fake-model");
    const task = await taskRow(taskId);
    expect(task).toMatchObject({
      status: "completed",
      result: "A chatbot replies; an agent acts with tools; a multi-agent system splits the work.",
      errorCode: null,
    });
    expect(task.startedAt).not.toBeNull();
    expect(task.finishedAt).not.toBeNull();
    expect(await runsOf(taskId)).toMatchObject([
      { status: "completed", attempt: 1, workerId: "test-worker", inputTokens: 10, partialOutput: null },
    ]);
    expect(await eventTypes(taskId)).toEqual(["created", "queued", "claimed", "started", "completed"]);
  });

  it("works for any agent: the agent, instructions, and model come from the database", async () => {
    const first = await insertAgent(db, { name: "Writer", instructions: "Write." });
    const second = await insertAgent(db, { name: "Checker", instructions: "Check." });
    await newTask(first.id);
    await newTask(second.id);
    const { executor, inputs } = worker(async () => answer("ok"));
    await executor.runOnce();
    await executor.runOnce();
    expect(inputs.map((input) => input.systemPrompt.split("\n\n").at(-1))).toEqual(["Write.", "Check."]);
  });

  it("is claimed by exactly one of two racing workers", async () => {
    const agent = await insertAgent(db);
    const { taskId } = await newTask(agent.id);
    const a = worker(async () => answer("from A"));
    const b = worker(async () => answer("from B"));

    await Promise.all([a.executor.runOnce(), b.executor.runOnce()]);
    expect(a.inputs.length + b.inputs.length).toBe(1);
    expect(await runsOf(taskId)).toHaveLength(1);
    expect((await eventTypes(taskId)).filter((type) => type === "claimed")).toHaveLength(1);
  });

  it("never runs a completed task again, after a restart or a retry request", async () => {
    const agent = await insertAgent(db);
    const { taskId } = await newTask(agent.id);
    const { executor, inputs } = worker(async () => answer("done"));
    await executor.runOnce();

    const restarted = worker(async () => answer("again"));
    expect(await restarted.executor.recoverStaleRuns()).toBe(0);
    expect(await restarted.executor.runOnce()).toBe(false);
    await expect(service.retry(taskId)).rejects.toMatchObject({ code: "invalid_state" });
    expect(inputs.length + restarted.inputs.length).toBe(1);
    expect((await taskRow(taskId)).result).toBe("done");
  });

  it("re-checks the agent when the attempt starts: a since-disabled agent fails the task without calling the runtime", async () => {
    const agent = await insertAgent(db);
    const { taskId } = await newTask(agent.id);
    await db.update(agents).set({ enabled: false }).where(eq(agents.id, agent.id));
    const { executor, inputs } = worker(async () => answer("unused"));
    await executor.runOnce();
    expect(inputs).toHaveLength(0);
    expect(await taskRow(taskId)).toMatchObject({ status: "failed", errorCode: "agent_unavailable" });
  });
});

describe("failures, timeouts, and retries", () => {
  it("stores a provider failure on the task, and doesn't retry it", async () => {
    const agent = await insertAgent(db);
    const { taskId } = await newTask(agent.id);
    const { executor } = worker(async () => ({ status: "failed", code: "provider_error", message: "Claude returned an error." }));
    await executor.runOnce();

    expect(await taskRow(taskId)).toMatchObject({
      status: "failed",
      errorCode: "provider_error",
      errorMessage: "Claude returned an error.",
    });
    expect(await runsOf(taskId)).toHaveLength(1);
    expect(await eventTypes(taskId)).toEqual(["created", "queued", "claimed", "started", "failed"]);
  });

  it("never retries a usage limit automatically: one call, one clear failure", async () => {
    const agent = await insertAgent(db);
    const { taskId } = await newTask(agent.id);
    const { executor, inputs } = worker(async () => ({
      status: "failed",
      code: "usage_limit",
      message: "You’ve reached your Claude usage limit. Try again after it resets.",
      retryAt: new Date(Date.now() + 3_600_000),
    }));
    await executor.runOnce();
    expect(await executor.runOnce()).toBe(false);

    expect(inputs).toHaveLength(1);
    expect(await taskRow(taskId)).toMatchObject({ status: "failed", errorCode: "usage_limit" });
    expect(await runsOf(taskId)).toHaveLength(1);
  });

  it("stops an attempt that takes too long, and fails it as a timeout, never as a success", async () => {
    const agent = await insertAgent(db);
    const { taskId } = await newTask(agent.id);
    const { executor } = worker((_input, signal) => untilAborted(signal), { taskTimeoutMs: 100 });
    await executor.runOnce();

    const task = await taskRow(taskId);
    expect(task).toMatchObject({ status: "failed", errorCode: "timeout", result: null });
    expect(task.errorMessage).toContain("didn’t finish");
  });

  it("retries a provider outage once, after a delay, as a new attempt", async () => {
    const agent = await insertAgent(db);
    const { taskId } = await newTask(agent.id);
    const outage = worker(async () => ({ status: "failed", code: "provider_unavailable", message: "Can’t reach Claude." }));
    await outage.executor.runOnce();

    const [first, second] = await runsOf(taskId);
    expect(first).toMatchObject({ status: "failed", errorCode: "provider_unavailable" });
    expect(second).toMatchObject({ status: "pending", attempt: 2 });
    expect(second.notBefore!.getTime()).toBeGreaterThan(Date.now());
    expect(await taskRow(taskId)).toMatchObject({ status: "queued", autoRetriesLeft: 0 });
    // Not before its time.
    expect(await outage.executor.runOnce()).toBe(false);

    await makeDue(taskId);
    await outage.executor.runOnce();
    // The retry was used: a second outage fails the task instead of looping.
    expect(await taskRow(taskId)).toMatchObject({ status: "failed", errorCode: "provider_unavailable" });
    expect(await runsOf(taskId)).toHaveLength(2);
    expect(await eventTypes(taskId)).toEqual([
      "created",
      "queued",
      "claimed",
      "started",
      "retry_scheduled",
      "claimed",
      "started",
      "failed",
    ]);
  });

  it("lets the owner retry a failed task as a new attempt, once, and resets the automatic retry", async () => {
    const agent = await insertAgent(db);
    const { taskId } = await newTask(agent.id);
    const failing = worker(async () => ({ status: "failed", code: "provider_error", message: "Error." }));
    await failing.executor.runOnce();
    await db.update(tasks).set({ autoRetriesLeft: 0 }).where(eq(tasks.id, taskId));

    const [retried, twice] = await Promise.allSettled([service.retry(taskId), service.retry(taskId)]);
    expect([retried.status, twice.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(await taskRow(taskId)).toMatchObject({ status: "queued", errorCode: null, errorMessage: null, autoRetriesLeft: 1 });
    expect((await runsOf(taskId)).map((run) => [run.attempt, run.status])).toEqual([
      [1, "failed"],
      [2, "pending"],
    ]);

    const working = worker(async () => answer("Second time lucky."));
    await working.executor.runOnce();
    expect(await taskRow(taskId)).toMatchObject({ status: "completed", result: "Second time lucky." });
  });

  it("refuses to retry while the agent is disabled", async () => {
    const agent = await insertAgent(db);
    const { taskId } = await newTask(agent.id);
    await worker(async () => ({ status: "failed", code: "provider_error", message: "Error." })).executor.runOnce();
    await db.update(agents).set({ enabled: false }).where(eq(agents.id, agent.id));
    await expect(service.retry(taskId)).rejects.toMatchObject({ code: "agent_unavailable" });
    expect(await runsOf(taskId)).toHaveLength(1);
  });
});

describe("cancellation", () => {
  it("cancels a queued task at once; the worker never starts it", async () => {
    const agent = await insertAgent(db);
    const { taskId } = await newTask(agent.id);
    await service.cancel(taskId);

    expect(await taskRow(taskId)).toMatchObject({ status: "cancelled" });
    expect(await runsOf(taskId)).toMatchObject([{ status: "cancelled" }]);
    const { executor, inputs } = worker(async () => answer("unused"));
    expect(await executor.runOnce()).toBe(false);
    expect(inputs).toHaveLength(0);
  });

  it("stops a running task through the worker, and shows 'cancelling' truthfully until it has", async () => {
    const agent = await insertAgent(db);
    const { taskId } = await newTask(agent.id);
    const { behave, running } = blocking();
    const { executor } = worker(behave);
    const execution = executor.runOnce();
    await running;

    const requested = await service.cancel(taskId);
    expect(requested.status).toBe("running");
    expect(requested.cancelRequestedAt).not.toBeNull();
    await execution;

    expect(await taskRow(taskId)).toMatchObject({ status: "cancelled" });
    expect(await runsOf(taskId)).toMatchObject([{ status: "cancelled" }]);
    expect((await eventTypes(taskId)).slice(-2)).toEqual(["cancel_requested", "cancelled"]);
  });

  it("refuses to cancel a finished task", async () => {
    const agent = await insertAgent(db);
    const { taskId } = await newTask(agent.id);
    await worker(async () => answer("done")).executor.runOnce();
    await expect(service.cancel(taskId)).rejects.toBeInstanceOf(TaskServiceError);
    expect((await taskRow(taskId)).status).toBe("completed");
  });

  it("never deadlocks or splits state when Cancel and a worker's claim race", async () => {
    const agent = await insertAgent(db);
    for (let round = 0; round < 10; round++) {
      const { taskId } = await newTask(agent.id);
      const { executor, inputs } = worker(async () => answer("raced"));
      const [claimed] = await Promise.all([executor.claimNextRun(), service.cancel(taskId).catch(() => null)]);
      if (claimed) await executor.executeRun(claimed);
      const task = await taskRow(taskId);
      const [run] = await runsOf(taskId);
      // Either the cancel won before the claim, or the claimed attempt saw the
      // request before calling the provider. Both end cancelled, run and task alike.
      expect(task.status).toBe("cancelled");
      expect(run.status).toBe("cancelled");
      expect(inputs).toHaveLength(0);
    }
  });
});

describe("worker restarts and recovery", () => {
  it("retries an attempt cut off by a worker shutdown, when it did nothing irreversible", async () => {
    const agent = await insertAgent(db);
    const { taskId } = await newTask(agent.id);
    const { behave, running } = blocking();
    const { executor } = worker(behave);
    const execution = executor.runOnce();
    await running;
    executor.abortActiveRuns();
    await execution;

    expect(await runsOf(taskId)).toMatchObject([
      { status: "failed", errorCode: "worker_stopped" },
      { status: "pending", attempt: 2 },
    ]);
    expect(await taskRow(taskId)).toMatchObject({ status: "queued" });

    // The restarted worker picks the retry up once it is due.
    const restarted = worker(async () => answer("Finished after the restart."));
    await makeDue(taskId);
    await restarted.executor.runOnce();
    expect(await taskRow(taskId)).toMatchObject({ status: "completed", result: "Finished after the restart." });
  });

  it("detects an expired lease (a crashed worker) and retries once, then interrupts", async () => {
    const agent = await insertAgent(db);
    const { taskId } = await newTask(agent.id);
    const crashed = worker(async () => answer("never"));
    // Claimed, then the worker "crashes": no execution, and the heartbeat goes stale.
    await crashed.executor.claimNextRun();
    await db.update(runs).set({ heartbeatAt: sql`now() - interval '1 minute'` }).where(eq(runs.taskId, taskId));

    const recovery = worker(async () => answer("unused"));
    expect(await recovery.executor.recoverStaleRuns()).toBe(1);
    expect(await taskRow(taskId)).toMatchObject({ status: "queued", autoRetriesLeft: 0 });

    // The retry is claimed and crashes too: no retries left, so it's interrupted for the owner.
    await makeDue(taskId);
    await crashed.executor.claimNextRun();
    await db.update(runs).set({ heartbeatAt: sql`now() - interval '1 minute'` }).where(eq(runs.status, "running"));
    await recovery.executor.recoverStaleRuns();
    const task = await taskRow(taskId);
    expect(task).toMatchObject({ status: "interrupted", errorCode: "worker_stopped" });
    expect(task.errorMessage).toContain("automatic retry was already used");
    expect(await runsOf(taskId)).toHaveLength(2);
    expect(recovery.inputs).toHaveLength(0);
  });

  it("leaves a task alone while its live worker keeps the lease fresh", async () => {
    const agent = await insertAgent(db);
    const { taskId } = await newTask(agent.id);
    const { behave, running } = blocking();
    const { executor } = worker(behave);
    const execution = executor.runOnce();
    await running;

    const other = worker(async () => answer("unused"));
    expect(await other.executor.recoverStaleRuns()).toBe(0);
    expect((await taskRow(taskId)).status).toBe("running");
    executor.abortActiveRuns();
    await execution;
  });

  it("keeps queued tasks across a restart: a new worker simply picks them up", async () => {
    const agent = await insertAgent(db);
    const { taskId } = await newTask(agent.id);
    const restarted = worker(async () => answer("Picked up later."));
    expect(await restarted.executor.recoverStaleRuns()).toBe(0);
    await restarted.executor.runOnce();
    expect((await taskRow(taskId)).status).toBe("completed");
  });

  it("interrupts, instead of repeating, an attempt where an action with side effects ran", async () => {
    const agent = await insertAgent(db);
    await db.insert(agentToolPermissions).values({ agentId: agent.id, toolId: "send_note", mode: "allow" });
    const { taskId } = await newTask(agent.id);
    const { behave, running } = blocking({ name: "send_note", text: "hello" });
    const { executor } = worker(behave);
    const execution = executor.runOnce();
    await running;
    executor.abortActiveRuns();
    await execution;

    const task = await taskRow(taskId);
    expect(task).toMatchObject({ status: "interrupted", errorCode: "worker_stopped" });
    expect(task.errorMessage).toContain("could do that twice");
    expect(await runsOf(taskId)).toHaveLength(1); // no automatic second attempt
    expect(toolRuns).toEqual(["send_note:hello"]); // the action ran exactly once
  });

  it("retries an attempt whose tools only read", async () => {
    const agent = await insertAgent(db);
    await db.insert(agentToolPermissions).values({ agentId: agent.id, toolId: "look_up", mode: "allow" });
    const { taskId } = await newTask(agent.id);
    const { behave, running } = blocking({ name: "look_up", text: "a" });
    const { executor } = worker(behave);
    const execution = executor.runOnce();
    await running;
    executor.abortActiveRuns();
    await execution;
    expect((await taskRow(taskId)).status).toBe("queued");
  });

  it("interrupts a task whose worker crashed while an approval was pending, and withdraws the request", async () => {
    const agent = await insertAgent(db);
    const { taskId } = await newTask(agent.id);
    // The state a crash leaves behind: a claimed attempt waiting on the owner,
    // with no process left to keep its heartbeat fresh.
    const crashed = worker(async () => answer("never"));
    const run = (await crashed.executor.claimNextRun())!;
    await db.update(tasks).set({ status: "awaiting_approval" }).where(eq(tasks.id, taskId));
    const [call] = await db
      .insert(toolCalls)
      .values({
        runId: run.id,
        toolId: "look_up",
        input: { text: "secret plan" },
        inputSummary: "secret plan",
        status: "awaiting_approval",
        requiresApproval: true,
        approvalExpiresAt: sql`now() + interval '5 minutes'`,
      })
      .returning();
    await db.update(runs).set({ heartbeatAt: sql`now() - interval '1 minute'` }).where(eq(runs.id, run.id));

    const recovery = worker(async () => answer("unused"));
    expect(await recovery.executor.recoverStaleRuns()).toBe(1);

    const task = await taskRow(taskId);
    expect(task.status).toBe("interrupted");
    expect(task.errorMessage).toContain("waited for your approval");
    const [withdrawn] = await db.select().from(toolCalls).where(eq(toolCalls.id, call.id));
    expect(withdrawn.status).toBe("cancelled");
    await expect(conversations.decideToolCall(call.id, "approve")).rejects.toMatchObject({ code: "validation_failed" });
    expect(toolRuns).toEqual([]);
    expect(await runsOf(taskId)).toHaveLength(1); // no automatic retry
  });

  it("interrupts a task whose worker was shut down while an approval was pending", async () => {
    const agent = await insertAgent(db);
    await db.insert(agentToolPermissions).values({ agentId: agent.id, toolId: "look_up", mode: "ask" });
    const { taskId } = await newTask(agent.id);
    const { executor } = worker(async (input) => {
      await input.tools[0].invoke({ text: "secret plan" });
      return answer("unused");
    });
    const execution = executor.runOnce();
    await waitFor(async () => (await taskRow(taskId)).status === "awaiting_approval");
    executor.abortActiveRuns();
    await execution;

    expect(await taskRow(taskId)).toMatchObject({ status: "interrupted", errorCode: "worker_stopped" });
    expect((await db.select().from(toolCalls))[0].status).toBe("cancelled");
    expect(toolRuns).toEqual([]);
    expect(await runsOf(taskId)).toHaveLength(1);
  });
});

describe("tools and approvals in a task", () => {
  it("gives the model only the agent's permitted tools, and records each step on the timeline", async () => {
    const agent = await insertAgent(db);
    await db.insert(agentToolPermissions).values({ agentId: agent.id, toolId: "look_up", mode: "allow" });
    const { taskId } = await newTask(agent.id);
    const { executor, inputs } = worker(async (input) => {
      const outcome = await input.tools[0].invoke({ text: "sources" });
      return answer(`Found: ${outcome.text}`);
    });
    await executor.runOnce();

    expect(inputs[0].tools.map((tool) => tool.name)).toEqual(["look_up"]);
    expect(await eventTypes(taskId)).toEqual([
      "created",
      "queued",
      "claimed",
      "started",
      "tool_requested",
      "tool_succeeded",
      "completed",
    ]);
    expect((await taskRow(taskId)).result).toBe('Found: {"text":"done sources"}');
  });

  it("refuses a tool whose permission was removed mid-run, and records the refusal", async () => {
    const agent = await insertAgent(db);
    await db.insert(agentToolPermissions).values({ agentId: agent.id, toolId: "send_note", mode: "allow" });
    const { taskId } = await newTask(agent.id);
    const { executor } = worker(async (input) => {
      await db.delete(agentToolPermissions).where(eq(agentToolPermissions.agentId, agent.id));
      const outcome = await input.tools[0].invoke({ text: "hi" });
      return answer(outcome.isError ? "Refused." : "Sent.");
    });
    await executor.runOnce();

    expect(toolRuns).toEqual([]);
    expect(await eventTypes(taskId)).toContain("tool_denied");
    expect((await taskRow(taskId)).result).toBe("Refused.");
  });

  async function taskWaitingForApproval(invokerLimits?: { approvalTtlMs: number; approvalPollMs: number }) {
    const agent = await insertAgent(db);
    await db.insert(agentToolPermissions).values({ agentId: agent.id, toolId: "send_note", mode: "ask" });
    const { taskId } = await newTask(agent.id);
    const { executor } = worker(
      async (input) => {
        const outcome = await input.tools[0].invoke({ text: "to the team" });
        return answer(outcome.isError ? `Not sent: ${outcome.text}` : "Sent.");
      },
      {},
      { invokerLimits },
    );
    const execution = executor.runOnce();
    const call = await waitFor(async () => (await db.select().from(toolCalls))[0]);
    return { taskId, call, execution, executor };
  }

  it("waits for approval (status awaiting_approval), then runs exactly the approved input", async () => {
    const { taskId, call, execution } = await taskWaitingForApproval();
    await waitFor(async () => (await taskRow(taskId)).status === "awaiting_approval");
    expect(call).toMatchObject({ status: "awaiting_approval", input: { text: "to the team" } });

    await conversations.decideToolCall(call.id, "approve");
    await execution;

    expect(toolRuns).toEqual(["send_note:to the team"]);
    expect(await taskRow(taskId)).toMatchObject({ status: "completed", result: "Sent." });
    expect(await eventTypes(taskId)).toEqual([
      "created",
      "queued",
      "claimed",
      "started",
      "tool_requested",
      "approval_requested",
      "approval_granted",
      "tool_succeeded",
      "completed",
    ]);
  });

  it("never runs a rejected action", async () => {
    const { taskId, call, execution } = await taskWaitingForApproval();
    await conversations.decideToolCall(call.id, "reject");
    await execution;

    expect(toolRuns).toEqual([]);
    expect((await taskRow(taskId)).result).toContain("rejected");
    expect(await eventTypes(taskId)).toContain("approval_rejected");
  });

  it("never runs an expired request, and refuses a late approval", async () => {
    const { taskId, call, execution } = await taskWaitingForApproval({ approvalTtlMs: 100, approvalPollMs: 10 });
    await execution;
    await expect(conversations.decideToolCall(call.id, "approve")).rejects.toMatchObject({ code: "validation_failed" });

    expect(toolRuns).toEqual([]);
    expect(await eventTypes(taskId)).toContain("approval_expired");
    expect((await taskRow(taskId)).status).toBe("completed");
  });

  it("withdraws a pending approval when the owner cancels the task", async () => {
    const { taskId, call, execution } = await taskWaitingForApproval();
    await waitFor(async () => (await taskRow(taskId)).status === "awaiting_approval");
    await service.cancel(taskId);
    await execution;

    expect(toolRuns).toEqual([]);
    expect(await taskRow(taskId)).toMatchObject({ status: "cancelled" });
    const [saved] = await db.select().from(toolCalls).where(eq(toolCalls.id, call.id));
    expect(saved.status).toBe("cancelled");
  });
});

describe("listing and reading tasks", () => {
  it("filters by status group and searches titles, instructions, and agent names", async () => {
    const researcher = await insertAgent(db, { name: "Research Assistant" });
    const writer = await insertAgent(db, { name: "Writer" });
    const { taskId: done } = await service.create({ agentId: researcher.id, title: "Compare frameworks", instructions: "Look at three." });
    await worker(async () => answer("ok")).executor.runOnce();
    const { taskId: queued } = await service.create({ agentId: writer.id, title: "Draft a post", instructions: "About 100% effort_" });
    const { taskId: cancelled } = await service.create({ agentId: writer.id, title: "Old idea", instructions: "Skip." });
    await service.cancel(cancelled);

    expect((await service.list()).map((task) => task.id).sort()).toEqual([done, queued, cancelled].sort());
    expect((await service.list({ filter: "completed" })).map((task) => task.id)).toEqual([done]);
    expect((await service.list({ filter: "queued" })).map((task) => task.id)).toEqual([queued]);
    expect((await service.list({ filter: "stopped" })).map((task) => task.id)).toEqual([cancelled]);
    expect((await service.list({ search: "writer" })).map((task) => task.id).sort()).toEqual([queued, cancelled].sort());
    expect((await service.list({ search: "three" })).map((task) => task.id)).toEqual([done]);
    // Wildcards are literal: "100%" matches only text containing "100%".
    expect((await service.list({ search: "100%" })).map((task) => task.id)).toEqual([queued]);
    expect((await service.list({ search: "_" })).map((task) => task.id)).toEqual([queued]);

    expect(await service.countByFilter()).toMatchObject({ all: 3, completed: 1, queued: 1, stopped: 1, running: 0 });
    expect(await service.countByFilter("writer")).toMatchObject({ all: 2, completed: 0 });
  });

  it("returns a task's attempts, timeline, and tool calls", async () => {
    const agent = await insertAgent(db);
    await db.insert(agentToolPermissions).values({ agentId: agent.id, toolId: "look_up", mode: "allow" });
    const { taskId } = await newTask(agent.id);
    await worker(async (input) => {
      await input.tools[0].invoke({ text: "x" });
      return answer("Result.");
    }).executor.runOnce();

    const detail = await service.get(taskId);
    expect(detail.task.result).toBe("Result.");
    expect(detail.agent).toMatchObject({ id: agent.id, name: agent.name });
    expect(detail.attempts).toMatchObject([{ attempt: 1, status: "completed" }]);
    expect(detail.events.map((event) => event.type)).toContain("tool_succeeded");
    expect(detail.toolCalls).toMatchObject([{ toolId: "look_up", status: "succeeded", inputSummary: "x" }]);
    expect(detail).not.toHaveProperty("attempts.0.workerId");
    await expect(service.get(crypto.randomUUID())).rejects.toMatchObject({ code: "not_found" });
    await expect(service.get("nope")).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("deletes an agent's tasks with the agent, stopping nothing else", async () => {
    const agent = await insertAgent(db);
    const other = await insertAgent(db, { name: "Other" });
    await newTask(agent.id);
    const { taskId: kept } = await newTask(other.id);
    await db.delete(agents).where(eq(agents.id, agent.id));
    expect((await db.select().from(tasks)).map((task) => task.id)).toEqual([kept]);
  });
});

describe("the worker loop", () => {
  it("runs at most `concurrency` attempts at once, and finishes them all", async () => {
    const agent = await insertAgent(db);
    for (let index = 0; index < 4; index++) await newTask(agent.id);
    let running = 0;
    let peak = 0;
    const { executor } = worker(async () => {
      running++;
      peak = Math.max(peak, running);
      await sleep(80);
      running--;
      return answer("ok");
    });

    let done = false;
    const loop = runWorkerLoop({
      executor,
      concurrency: 2,
      limits: { pollIntervalMs: 10, recoveryIntervalMs: 60_000 },
      log: silentLog,
      shouldStop: () => done,
    });
    await waitFor(async () => (await db.select().from(tasks)).every((task) => task.status === "completed"), 5_000);
    done = true;
    await loop;
    expect(peak).toBe(2);
  });

  it("runs one at a time by default", async () => {
    const agent = await insertAgent(db);
    for (let index = 0; index < 3; index++) await newTask(agent.id);
    let running = 0;
    let peak = 0;
    const { executor } = worker(async () => {
      running++;
      peak = Math.max(peak, running);
      await sleep(30);
      running--;
      return answer("ok");
    });
    let done = false;
    const loop = runWorkerLoop({
      executor,
      concurrency: 1,
      limits: { pollIntervalMs: 10, recoveryIntervalMs: 60_000 },
      log: silentLog,
      shouldStop: () => done,
    });
    await waitFor(async () => (await db.select().from(tasks)).every((task) => task.status === "completed"), 5_000);
    done = true;
    await loop;
    expect(peak).toBe(1);
  });
});
