import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createConversationService } from "@/server/conversations/service";
import { closeDatabase, createDatabase } from "@/server/db/client";
import { agents, runs } from "@/server/db/schema";
import type { Logger } from "@/server/logger";
import type { OnProgress, RunInput, RunResult } from "@/server/runtime/types";
import { createRunExecutor, type ExecutorLimits } from "./executor";
import { fakeRuntime, insertAgent, testProviders, untilAborted } from "./test-helpers";

// Integration tests for the worker's side, against the test database, with a
// fake runtime in place of Claude.

const db = createDatabase(process.env.TEST_DATABASE_URL!);
const conversations = createConversationService({ db, providers: testProviders });
const silentLog: Logger = () => {};
const limits: ExecutorLimits = {
  timeoutMs: 5_000,
  heartbeatMs: 20,
  staleAfterMs: 30_000,
  progressWriteMs: 10,
  historyMessages: 20,
  historyCharacters: 60_000,
};

const answer = (text: string): RunResult => ({ status: "completed", text, usage: { inputTokens: 10, outputTokens: 5 } });

function executorWith(
  behave: (input: RunInput, signal: AbortSignal, onProgress?: OnProgress) => Promise<RunResult>,
  overrides: Partial<ExecutorLimits> = {},
) {
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

/** A runtime that signals when it starts, then waits to be aborted. */
function blockingRuntime() {
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  const behave = (_input: RunInput, signal: AbortSignal) => {
    started();
    return untilAborted(signal);
  };
  return { behave, running };
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
      partialOutput: null,
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

  it("uses the agent's latest saved instructions, even in an existing conversation", async () => {
    const agent = await insertAgent(db, { instructions: "Version one." });
    const { conversationId } = await conversations.sendMessage({ agentId: agent.id, content: "Hi" });
    const { executor, inputs } = executorWith(async () => answer("Hello"));
    await executor.runOnce();

    await db.update(agents).set({ instructions: "Version two." }).where(eq(agents.id, agent.id));
    await conversations.sendMessage({ conversationId, content: "Again" });
    await executor.runOnce();

    expect(inputs.map((input) => input.systemPrompt)).toEqual(["Version one.", "Version two."]);
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

describe("multi-turn context", () => {
  it("gives the agent the earlier turns, so 'this project' can be understood", async () => {
    const agent = await insertAgent(db);
    const { conversationId } = await conversations.sendMessage({
      agentId: agent.id,
      content: "My project uses Next.js and PostgreSQL.",
    });
    const { executor, inputs } = executorWith(async () => answer("Understood."));
    await executor.runOnce();

    await conversations.sendMessage({
      conversationId,
      content: "Which database library would you recommend for this project?",
    });
    await executor.runOnce();

    const prompt = inputs[1].prompt;
    expect(prompt).toContain("<user>\nMy project uses Next.js and PostgreSQL.\n</user>");
    expect(prompt).toContain("<assistant>\nUnderstood.\n</assistant>");
    expect(prompt.endsWith("Which database library would you recommend for this project?")).toBe(true);
  });

  it("never mixes conversations, even with the same agent", async () => {
    const agent = await insertAgent(db);
    const { executor, inputs } = executorWith(async (input) => answer(`Reply to: ${input.prompt.slice(-12)}`));
    const first = await conversations.sendMessage({ agentId: agent.id, content: "Secret about project Alpha" });
    await executor.runOnce();
    const second = await conversations.sendMessage({ agentId: agent.id, content: "Talk about project Beta" });
    await executor.runOnce();
    await conversations.sendMessage({ conversationId: second.conversationId, content: "Continue" });
    await executor.runOnce();

    expect(first.conversationId).not.toBe(second.conversationId);
    expect(inputs[2].prompt).toContain("project Beta");
    expect(inputs[2].prompt).not.toContain("Alpha");
  });

  it("never mixes agents: each run uses its own conversation's agent", async () => {
    const researcher = await insertAgent(db, { name: "Researcher", instructions: "Research." });
    const writer = await insertAgent(db, { name: "Writer", instructions: "Write." });
    const { executor, inputs } = executorWith(async () => answer("ok"));
    await conversations.sendMessage({ agentId: researcher.id, content: "Researcher topic" });
    await executor.runOnce();
    const { conversationId } = await conversations.sendMessage({ agentId: writer.id, content: "Writer topic" });
    await executor.runOnce();
    await conversations.sendMessage({ conversationId, content: "More" });
    await executor.runOnce();

    expect(inputs[2].systemPrompt).toBe("Write.");
    expect(inputs[2].prompt).not.toContain("Researcher topic");
  });
});

describe("streaming", () => {
  it("saves the reply written so far while the run is running", async () => {
    const agent = await insertAgent(db);
    const { runId } = await conversations.sendMessage({ agentId: agent.id, content: "Hi" });
    let observed: string | null = null;
    const { executor } = executorWith(async (_input, _signal, onProgress) => {
      onProgress?.("Hello");
      onProgress?.("Hello, world");
      await new Promise((resolve) => setTimeout(resolve, 80)); // a few progress writes
      observed = (await runRow(runId)).partialOutput;
      return answer("Hello, world!");
    });

    await executor.runOnce();
    expect(observed).toBe("Hello, world");
    // Once finished, the reply is a message and the draft is cleared.
    expect((await runRow(runId)).partialOutput).toBeNull();
  });

  it("keeps the partial text of a stopped run, but never adds it to the conversation", async () => {
    const agent = await insertAgent(db);
    const { runId, conversationId } = await conversations.sendMessage({ agentId: agent.id, content: "Hi" });
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const { executor } = executorWith((_input, signal, onProgress) => {
      onProgress?.("Half an ans");
      started();
      return untilAborted(signal);
    });

    const execution = executor.runOnce();
    await running;
    await conversations.cancelRun(runId);
    await execution;

    expect(await runRow(runId)).toMatchObject({ status: "cancelled", partialOutput: "Half an ans" });
    expect((await conversations.get(conversationId)).messages).toHaveLength(1);
  });
});

describe("timeouts, cancellation, and deletion", () => {
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
    const { behave, running } = blockingRuntime();
    const { executor } = executorWith(behave);

    const execution = executor.runOnce();
    await running;
    await conversations.cancelRun(runId);
    await execution;

    expect(await runRow(runId)).toMatchObject({ status: "cancelled", errorCode: null });
  });

  it("abandons the provider call when the conversation is deleted mid-run", async () => {
    const agent = await insertAgent(db);
    const { conversationId } = await conversations.sendMessage({ agentId: agent.id, content: "Hi" });
    const { behave, running } = blockingRuntime();
    const { executor } = executorWith(behave);

    const execution = executor.runOnce();
    await running;
    await conversations.remove(conversationId);
    await execution; // resolves because the heartbeat found no run and aborted

    expect(await db.select().from(runs)).toHaveLength(0);
  });

  it("never starts a run that was cancelled while pending", async () => {
    const agent = await insertAgent(db);
    const { runId } = await conversations.sendMessage({ agentId: agent.id, content: "Hi" });
    await conversations.cancelRun(runId);
    const { executor, inputs } = executorWith(async () => answer("unused"));

    expect(await executor.runOnce()).toBe(false);
    expect(inputs).toHaveLength(0);
  });
});

describe("worker restarts and recovery", () => {
  it("marks the active run failed when the worker shuts down", async () => {
    const agent = await insertAgent(db);
    const { runId } = await conversations.sendMessage({ agentId: agent.id, content: "Hi" });
    const { behave, running } = blockingRuntime();
    const { executor } = executorWith(behave);

    const execution = executor.runOnce();
    await running;
    executor.abortActiveRun();
    await execution;

    expect(await runRow(runId)).toMatchObject({ status: "failed", errorCode: "worker_stopped" });
  });

  it("fails runs whose worker stopped sending heartbeats, and does not re-run them", async () => {
    const agent = await insertAgent(db);
    const { runId } = await conversations.sendMessage({ agentId: agent.id, content: "Hi" });
    await db
      .update(runs)
      .set({ status: "running", heartbeatAt: sql`now() - interval '5 minutes'` })
      .where(eq(runs.id, runId));
    const { executor, inputs } = executorWith(async () => answer("unused"));

    expect(await executor.recoverStaleRuns()).toBe(1);
    expect(await runRow(runId)).toMatchObject({ status: "failed", errorCode: "worker_stopped" });
    expect(await executor.runOnce()).toBe(false);
    expect(inputs).toHaveLength(0);
  });

  it("leaves a run alone while another live worker keeps its heartbeat fresh", async () => {
    const agent = await insertAgent(db);
    const { runId } = await conversations.sendMessage({ agentId: agent.id, content: "Hi" });
    const { behave, running } = blockingRuntime();
    const { executor: workerA } = executorWith(behave);
    const { executor: workerB } = executorWith(async () => answer("unused"));

    const execution = workerA.runOnce();
    await running;
    expect(await workerB.recoverStaleRuns()).toBe(0); // B starting up must not steal A's run
    expect((await runRow(runId)).status).toBe("running");

    await conversations.cancelRun(runId);
    await execution;
  });

  it("keeps pending runs across a restart: a new worker simply picks them up", async () => {
    const agent = await insertAgent(db);
    const { runId } = await conversations.sendMessage({ agentId: agent.id, content: "Hi" });
    const { executor: restarted } = executorWith(async () => answer("Answered after restart"));

    expect(await restarted.recoverStaleRuns()).toBe(0);
    await restarted.runOnce();
    expect((await runRow(runId)).status).toBe("completed");
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
