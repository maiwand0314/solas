import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createConversationService } from "@/server/conversations/service";
import { closeDatabase, createDatabase } from "@/server/db/client";
import { agents, runs } from "@/server/db/schema";
import type { Logger } from "@/server/logger";
import type { RunInput, RunResult } from "@/server/runtime/types";
import { createRunExecutor } from "./executor";
import { fakeRuntime, insertAgent, testProviders, untilAborted } from "./test-helpers";

// Integration tests for the worker's side, against the test database, with a
// fake runtime in place of Claude.

const db = createDatabase(process.env.TEST_DATABASE_URL!);
const conversations = createConversationService({ db, providers: testProviders });
const silentLog: Logger = () => {};
const limits = { timeoutMs: 5_000, cancelCheckMs: 20, historyMessages: 20, historyCharacters: 60_000 };

const answer = (text: string): RunResult => ({ status: "completed", text, usage: { inputTokens: 10, outputTokens: 5 } });

function executorWith(behave: (input: RunInput, signal: AbortSignal) => Promise<RunResult>, overrides = {}) {
  const { runtime, inputs } = fakeRuntime(behave);
  const executor = createRunExecutor({
    db,
    providers: testProviders,
    runtimes: [runtime],
    log: silentLog,
    limits: { ...limits, ...overrides },
  });
  return { executor, inputs };
}

async function runRow(id: string) {
  const [row] = await db.select().from(runs).where(eq(runs.id, id));
  return row;
}

beforeEach(async () => {
  await db.delete(agents);
});

afterAll(async () => {
  await closeDatabase(db);
});

describe("executing a run", () => {
  it("does nothing when no run is pending", async () => {
    const { executor, inputs } = executorWith(async () => answer("unused"));
    expect(await executor.runOnce()).toBe(false);
    expect(inputs).toHaveLength(0);
  });

  it("runs the agent with its stored instructions and model, and saves the real reply", async () => {
    const agent = await insertAgent(db, { instructions: "Answer like a statistics professor." });
    const { conversationId, runId } = await conversations.sendMessage({ agentId: agent.id, content: "What is ML?" });
    const { executor, inputs } = executorWith(async () => answer("Machine learning is…"));

    expect(await executor.runOnce()).toBe(true);

    expect(inputs).toEqual([{ systemPrompt: "Answer like a statistics professor.", prompt: "What is ML?", model: "fake-model" }]);
    expect(await runRow(runId)).toMatchObject({
      status: "completed",
      modelId: "fake-model",
      inputTokens: 10,
      outputTokens: 5,
    });
    const thread = await conversations.get(conversationId);
    expect(thread.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "What is ML?"],
      ["assistant", "Machine learning is…"],
    ]);
    expect(thread.messages[1].runId).toBe(runId);
  });

  it("works the same for any agent: the agent comes from the database, not from code", async () => {
    const writer = await insertAgent(db, { name: "Writer", instructions: "Write short poems." });
    await conversations.sendMessage({ agentId: writer.id, content: "A poem about rain" });
    const { executor, inputs } = executorWith(async () => answer("Rain…"));

    await executor.runOnce();
    expect(inputs[0].systemPrompt).toBe("Write short poems.");
  });

  it("includes earlier turns of the conversation in the next run", async () => {
    const agent = await insertAgent(db);
    const { conversationId } = await conversations.sendMessage({ agentId: agent.id, content: "What is ML?" });
    const { executor, inputs } = executorWith(async () => answer("An answer."));
    await executor.runOnce();

    await conversations.sendMessage({ conversationId, content: "Give an example." });
    await executor.runOnce();

    expect(inputs[1].prompt).toContain("<user>\nWhat is ML?");
    expect(inputs[1].prompt).toContain("<assistant>\nAn answer.");
    expect(inputs[1].prompt.endsWith("Give an example.")).toBe(true);
  });

  it("records a provider failure with its code and message, and no reply", async () => {
    const agent = await insertAgent(db);
    const { runId, conversationId } = await conversations.sendMessage({ agentId: agent.id, content: "Hi" });
    const { executor } = executorWith(async () => ({
      status: "failed",
      code: "usage_limit",
      message: "You’ve reached your Claude usage limit.",
    }));

    await executor.runOnce();
    expect(await runRow(runId)).toMatchObject({
      status: "failed",
      errorCode: "usage_limit",
      errorMessage: "You’ve reached your Claude usage limit.",
    });
    expect((await conversations.get(conversationId)).messages).toHaveLength(1);
  });

  it("doesn't leak internal error text when the runtime crashes", async () => {
    const agent = await insertAgent(db);
    const { runId } = await conversations.sendMessage({ agentId: agent.id, content: "Hi" });
    const { executor } = executorWith(async () => {
      throw new Error("connect failed: DATABASE_URL=postgres://solas:hunter2@host");
    });

    await executor.runOnce();
    const row = await runRow(runId);
    expect(row.status).toBe("failed");
    expect(row.errorMessage).not.toContain("hunter2");
  });

  it("re-checks the agent at run time: a disabled agent never reaches the runtime", async () => {
    const agent = await insertAgent(db);
    const { runId } = await conversations.sendMessage({ agentId: agent.id, content: "Hi" });
    await db.update(agents).set({ enabled: false }).where(eq(agents.id, agent.id));
    const { executor, inputs } = executorWith(async () => answer("unused"));

    await executor.runOnce();
    expect(inputs).toHaveLength(0);
    expect(await runRow(runId)).toMatchObject({ status: "failed", errorCode: "agent_unavailable" });
  });
});

describe("timeouts and cancellation", () => {
  it("stops a run that takes too long and marks it failed", async () => {
    const agent = await insertAgent(db);
    const { runId } = await conversations.sendMessage({ agentId: agent.id, content: "Hi" });
    const { executor } = executorWith((_input, signal) => untilAborted(signal), { timeoutMs: 50 });

    await executor.runOnce();
    expect(await runRow(runId)).toMatchObject({ status: "failed", errorCode: "timeout" });
  });

  it("stops a running run when the owner presses Stop", async () => {
    const agent = await insertAgent(db);
    const { runId } = await conversations.sendMessage({ agentId: agent.id, content: "Hi" });
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const { executor } = executorWith((_input, signal) => {
      started();
      return untilAborted(signal);
    });

    const execution = executor.runOnce();
    await running;
    await conversations.cancelRun(runId);
    await execution;

    expect(await runRow(runId)).toMatchObject({ status: "cancelled", errorCode: null });
  });

  it("never starts a run that was cancelled while pending", async () => {
    const agent = await insertAgent(db);
    const { runId } = await conversations.sendMessage({ agentId: agent.id, content: "Hi" });
    await conversations.cancelRun(runId);
    const { executor, inputs } = executorWith(async () => answer("unused"));

    expect(await executor.runOnce()).toBe(false);
    expect(inputs).toHaveLength(0);
  });

  it("marks the active run failed when the worker shuts down", async () => {
    const agent = await insertAgent(db);
    const { runId } = await conversations.sendMessage({ agentId: agent.id, content: "Hi" });
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const { executor } = executorWith((_input, signal) => {
      started();
      return untilAborted(signal);
    });

    const execution = executor.runOnce();
    await running;
    executor.abortActiveRun();
    await execution;

    expect(await runRow(runId)).toMatchObject({ status: "failed", errorCode: "worker_stopped" });
  });

  it("on start, fails runs left running by a crashed worker", async () => {
    const agent = await insertAgent(db);
    const { runId } = await conversations.sendMessage({ agentId: agent.id, content: "Hi" });
    await db.update(runs).set({ status: "running" }).where(eq(runs.id, runId));
    const { executor } = executorWith(async () => answer("unused"));

    expect(await executor.recoverInterruptedRuns()).toBe(1);
    expect(await runRow(runId)).toMatchObject({ status: "failed", errorCode: "worker_stopped" });
  });
});

describe("claiming", () => {
  it("claims the oldest pending run first", async () => {
    const agent = await insertAgent(db);
    const first = await conversations.sendMessage({ agentId: agent.id, content: "First" });
    const second = await conversations.sendMessage({ agentId: agent.id, content: "Second" });
    const { executor } = executorWith(async () => answer("unused"));

    expect((await executor.claimNextRun())?.id).toBe(first.runId);
    expect((await executor.claimNextRun())?.id).toBe(second.runId);
    expect(await executor.claimNextRun()).toBeNull();
  });

  it("never gives the same run to two claims at once", async () => {
    const agent = await insertAgent(db);
    const first = await conversations.sendMessage({ agentId: agent.id, content: "First" });
    const second = await conversations.sendMessage({ agentId: agent.id, content: "Second" });
    const { executor } = executorWith(async () => answer("unused"));

    const claimed = (await Promise.all([executor.claimNextRun(), executor.claimNextRun()]))
      .filter((run) => run !== null)
      .map((run) => run.id);
    expect(new Set(claimed).size).toBe(claimed.length);

    // A simultaneous claim may come back empty (see claimNextRun); whatever it
    // skipped is still pending and is claimed next time.
    for (let run = await executor.claimNextRun(); run; run = await executor.claimNextRun()) claimed.push(run.id);
    expect(new Set(claimed)).toEqual(new Set([first.runId, second.runId]));
  });
});
