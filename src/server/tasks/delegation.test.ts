import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createAgentService } from "@/server/agents/service";
import { createConversationService } from "@/server/conversations/service";
import { closeDatabase, createDatabase } from "@/server/db/client";
import {
  agentDelegationTargets,
  agents,
  agentToolPermissions,
  runs,
  taskDelegations,
  taskEvents,
  tasks,
  toolCalls,
} from "@/server/db/schema";
import type { Logger } from "@/server/logger";
import { createRunExecutor, type ExecutorLimits } from "@/server/runs/executor";
import { fakeRuntime, insertAgent, testProviders } from "@/server/runs/test-helpers";
import { runWorkerLoop } from "@/server/runs/worker-loop";
import type { RunInput, RunResult } from "@/server/runtime/types";
import { delegateToAgentTool } from "@/server/tools/builtin/delegate";
import { createToolInvoker } from "@/server/tools/invoker";
import { createToolRegistry } from "@/server/tools/registry";
import type { AnyToolDefinition } from "@/server/tools/types";
import { delegate } from "./delegation";
import { createTaskService } from "./service";

// Delegation between agents (M5A), end to end on the backend: the web side
// (task service), the worker side (run executor), and the delegation rules,
// against the test database. A fake runtime plays both agents; nothing here
// calls the real Claude service.

const db = createDatabase(process.env.TEST_DATABASE_URL!);
const service = createTaskService({ db, providers: testProviders, limits: { taskAutoRetries: 1 } });
const agentService = createAgentService({ db, providers: testProviders });
const conversations = createConversationService({ db, providers: testProviders });
const silentLog: Logger = () => {};
const limits: ExecutorLimits = {
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

const answer = (text: string): RunResult => ({ status: "completed", text, usage: { inputTokens: 10, outputTokens: 5 } });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(check: () => Promise<T | undefined | null | false>, timeoutMs = 4_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await sleep(10);
  }
  throw new Error("Timed out waiting for a condition.");
}

// Tools: a read-only one and one that needs approval.
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
  delegateToAgentTool,
]);
const invoker = createToolInvoker({
  db,
  registry,
  log: silentLog,
  limits: { approvalTtlMs: 5_000, approvalPollMs: 10 },
  workspaceFor: async () => "/nonexistent",
});

const PARENT = "You are the researcher.";
const CHILD = "You are the writer.";
const REQUEST = "Turn these findings into a short report: A is fast, B is safe, C is cheap.";

type Behave = (input: RunInput, signal: AbortSignal) => Promise<RunResult>;

/** One fake runtime for both agents, told apart by their instructions. */
function team({ parent, child }: { parent?: Behave; child?: Behave } = {}) {
  const parentInputs: RunInput[] = [];
  const childInputs: RunInput[] = [];
  const { runtime } = fakeRuntime((input, signal) => {
    if (input.systemPrompt.endsWith(CHILD)) {
      childInputs.push(input);
      return (child ?? (async () => answer("REPORT: A fast; B safe; C cheap.")))(input, signal);
    }
    parentInputs.push(input);
    return (parent ?? researcher())(input, signal);
  });
  const executor = createRunExecutor({
    db,
    providers: testProviders,
    runtimes: [runtime],
    log: silentLog,
    tools: invoker,
    isReadOnlyTool: (id) => registry.get(id)?.sideEffects === false,
    workerId: "test-worker",
    limits,
  });
  return { executor, parentInputs, childInputs };
}

let writerId = "";
/** The parent agent's default behavior: delegate in the work run, finish in the follow-up. */
function researcher(request: Record<string, unknown> = {}): Behave {
  return async (input) => {
    if (input.prompt.includes("delegated part of it")) {
      const result = /<delegated_result>\n([\s\S]*?)\n<\/delegated_result>/.exec(input.prompt)?.[1];
      return answer(result ? `FINAL using ${result}` : "FINAL without the delegated result");
    }
    const tool = input.tools.find((candidate) => candidate.name === "delegate_to_agent");
    if (!tool) return answer("Did it myself: no delegation available.");
    const outcome = await tool.invoke({ targetAgentId: writerId, taskDescription: REQUEST, expectedOutput: "Three bullets", ...request });
    return answer(outcome.isError ? `Refused: ${outcome.text}` : "Findings: A fast, B safe, C cheap. Delegated the report.");
  };
}

async function setup({ allow = true } = {}) {
  const researcherAgent = await insertAgent(db, { name: "Research Assistant", instructions: PARENT });
  const writer = await insertAgent(db, { name: "Writing Assistant", role: "writing", instructions: CHILD });
  writerId = writer.id;
  if (allow) await db.insert(agentDelegationTargets).values({ agentId: researcherAgent.id, targetAgentId: writer.id });
  const { taskId } = await service.create({
    agentId: researcherAgent.id,
    title: "Compare three systems",
    instructions: "Analyze A, B, and C. Ask the Writing Assistant to turn your findings into a report.",
  });
  return { researcher: researcherAgent, writer, taskId };
}

async function taskRow(id: string) {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  return row;
}
async function childrenOf(taskId: string) {
  return db.select().from(tasks).where(eq(tasks.parentTaskId, taskId));
}
async function delegationsOf(taskId: string) {
  return db.select().from(taskDelegations).where(eq(taskDelegations.parentTaskId, taskId));
}
async function eventTypes(taskId: string) {
  const rows = await db.select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).orderBy(asc(taskEvents.id));
  return rows.map((row) => row.type);
}
async function runsOf(taskId: string) {
  return db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(asc(runs.attempt));
}

beforeEach(async () => {
  toolRuns = [];
  await db.delete(agents); // cascades to targets, tasks, runs, delegations, events
});

afterAll(async () => {
  await closeDatabase(db);
});

describe("an authorized delegation, end to end", () => {
  it("parent delegates, waits without a worker slot, the child runs, and the parent finishes with its result", async () => {
    const { researcher: parentAgent, writer, taskId } = await setup();
    const { executor, parentInputs, childInputs } = team();

    // 1. The parent's work run delegates, then ends: the task waits.
    await executor.runOnce();
    expect(parentInputs[0].tools.map((tool) => tool.name)).toEqual(["delegate_to_agent"]);
    expect(parentInputs[0].tools[0].description).toContain(`${writer.id}: Writing Assistant (writing)`);
    expect(await taskRow(taskId)).toMatchObject({ status: "waiting_on_delegate", result: null });
    const [child] = await childrenOf(taskId);
    expect(child).toMatchObject({ agentId: writer.id, parentTaskId: taskId, depth: 1, status: "queued" });
    const [delegation] = await delegationsOf(taskId);
    expect(delegation).toMatchObject({
      parentAgentId: parentAgent.id,
      targetAgentId: writer.id,
      childTaskId: child.id,
      taskDescription: REQUEST,
      expectedOutput: "Three bullets",
      status: "waiting",
      parentNotes: "Findings: A fast, B safe, C cheap. Delegated the report.",
    });
    expect(await runsOf(taskId)).toMatchObject([{ status: "completed", purpose: "work" }]); // no run held open

    // 2. The child runs as itself, with only what was sent.
    await executor.runOnce();
    expect(childInputs[0].systemPrompt.endsWith(CHILD)).toBe(true);
    expect(childInputs[0].prompt).toContain(REQUEST);
    expect(childInputs[0].prompt).toContain("Expected output: Three bullets");
    expect(childInputs[0].prompt).toContain("Delegated to you by Research Assistant");
    expect(childInputs[0].prompt).not.toContain("Analyze A, B, and C"); // the owner's task isn't passed on
    expect(childInputs[0].prompt).not.toContain(PARENT); // nor the parent's instructions
    expect(childInputs[0].tools).toEqual([]); // a delegated task can't delegate again
    expect(await taskRow(child.id)).toMatchObject({ status: "completed", result: "REPORT: A fast; B safe; C cheap." });
    expect(await taskRow(taskId)).toMatchObject({ status: "queued" });
    expect((await delegationsOf(taskId))[0]).toMatchObject({ status: "completed" });

    // 3. The parent's follow-up run gets its notes and the child's result, and finishes.
    await executor.runOnce();
    const followUp = parentInputs[1];
    expect(followUp.tools).toEqual([]); // no delegating again from the follow-up
    expect(followUp.prompt).toContain("<your_notes>\nFindings: A fast, B safe, C cheap. Delegated the report.\n</your_notes>");
    expect(followUp.prompt).toContain("<delegated_result>\nREPORT: A fast; B safe; C cheap.\n</delegated_result>");
    expect(await taskRow(taskId)).toMatchObject({ status: "completed", result: "FINAL using REPORT: A fast; B safe; C cheap." });
    expect(await runsOf(taskId)).toMatchObject([
      { attempt: 1, purpose: "work", status: "completed" },
      { attempt: 2, purpose: "continue", status: "completed" },
    ]);
    expect((await delegationsOf(taskId))[0].resultDeliveredAt).not.toBeNull();
    expect(await eventTypes(taskId)).toEqual([
      "created",
      "queued",
      "claimed",
      "started",
      "tool_requested",
      "delegated",
      "tool_succeeded",
      "waiting_on_delegate",
      "delegate_finished",
      "continuation_queued",
      "claimed",
      "started",
      "completed",
    ]);
    expect(await eventTypes(child.id)).toEqual(["created", "queued", "claimed", "started", "completed"]);
  });

  it("works with one worker: the waiting parent never blocks its child (no deadlock)", async () => {
    const { taskId } = await setup();
    const { executor } = team();
    let done = false;
    const loop = runWorkerLoop({
      executor,
      concurrency: 1,
      limits: { pollIntervalMs: 10, recoveryIntervalMs: 60_000 },
      log: silentLog,
      shouldStop: () => done,
    });
    await waitFor(async () => (await taskRow(taskId)).status === "completed");
    done = true;
    await loop;
    expect((await taskRow(taskId)).result).toContain("FINAL using REPORT");
  });

  it("with two workers, a child that finishes before its parent's run ends is picked up straight away", async () => {
    const { taskId } = await setup();
    const delegateThenLinger = researcher();
    const { executor } = team({
      parent: async (input, signal) => {
        const result = await delegateThenLinger(input, signal);
        // The work run stays open until the child's result is saved.
        if (!input.prompt.includes("delegated part of it")) {
          await waitFor(async () => (await childrenOf(taskId))[0]?.status === "completed");
        }
        return result;
      },
      child: async () => answer("REPORT: quick"),
    });
    let done = false;
    const loop = runWorkerLoop({
      executor,
      concurrency: 2,
      limits: { pollIntervalMs: 10, recoveryIntervalMs: 60_000 },
      log: silentLog,
      shouldStop: () => done,
    });
    await waitFor(async () => (await taskRow(taskId)).status === "completed");
    done = true;
    await loop;
    expect((await taskRow(taskId)).result).toBe("FINAL using REPORT: quick");
    // The parent never waited: the result was already there when its run ended.
    expect(await eventTypes(taskId)).not.toContain("waiting_on_delegate");
    expect(await eventTypes(taskId)).toContain("continuation_queued");
  });
});

describe("delegation rules, enforced by the backend", () => {
  it("doesn't offer the tool to an agent without delegation targets", async () => {
    const { taskId } = await setup({ allow: false });
    const { executor, parentInputs } = team();
    await executor.runOnce();
    expect(parentInputs[0].tools).toEqual([]);
    expect(await taskRow(taskId)).toMatchObject({ status: "completed", result: "Did it myself: no delegation available." });
    expect(await childrenOf(taskId)).toEqual([]);
  });

  async function refusal(request: Record<string, unknown>, prepare?: (ids: { researcher: string; writer: string }) => Promise<void>) {
    const { researcher: parentAgent, writer, taskId } = await setup();
    await prepare?.({ researcher: parentAgent.id, writer: writer.id });
    const { executor } = team({ parent: researcher(request) });
    await executor.runOnce();
    expect(await childrenOf(taskId)).toEqual([]);
    expect(await delegationsOf(taskId)).toEqual([]);
    const task = await taskRow(taskId);
    expect(task.status).toBe("completed");
    return task.result!;
  }

  it("refuses an agent that isn't an allowed target (or doesn't exist)", async () => {
    expect(await refusal({ targetAgentId: crypto.randomUUID() })).toContain("You may not delegate to that agent");
  });

  it("refuses a target that has been disabled: not offered, and refused if asked for anyway", async () => {
    const { writer, taskId } = await setup();
    await db.update(agents).set({ enabled: false }).where(eq(agents.id, writer.id));
    const { executor, parentInputs } = team({
      parent: async (input) => {
        // The backend refuses even when called directly from this run.
        const [run] = await runsOf(taskId);
        await expect(
          delegate(db, { run, request: { targetAgentId: writer.id, taskDescription: REQUEST }, providers: testProviders, autoRetries: 1 }),
        ).rejects.toThrow("Writing Assistant is disabled");
        return answer(`tools: ${input.tools.length}`);
      },
    });
    await executor.runOnce();
    expect(parentInputs[0].tools).toEqual([]); // its only target is disabled, so the tool isn't offered
    expect(await childrenOf(taskId)).toEqual([]);
  });

  it("refuses self-delegation, which the database won't even store as a target", async () => {
    const { researcher: parentAgent } = await setup();
    await expect(
      db.insert(agentDelegationTargets).values({ agentId: parentAgent.id, targetAgentId: parentAgent.id }),
    ).rejects.toThrow();
    await db.delete(agents);
    expect(
      await refusal({}, async ({ researcher: id }) => {
        writerId = id; // ask for itself
      }),
    ).toContain("can’t delegate to itself");
  });

  it("stops at depth one: a delegated task can't delegate, even back to its parent (no cycles)", async () => {
    const { researcher: parentAgent, writer, taskId } = await setup();
    // The writer may delegate back to the researcher: a cycle, if depth weren't limited.
    await db.insert(agentDelegationTargets).values({ agentId: writer.id, targetAgentId: parentAgent.id });
    const { executor, childInputs } = team();
    await executor.runOnce(); // parent delegates
    await executor.runOnce(); // child runs
    expect(childInputs[0].tools).toEqual([]);

    // And asking the backend directly from the child's run is refused too.
    const [child] = await childrenOf(taskId);
    const [childRun] = await runsOf(child.id);
    await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, child.id));
    await expect(
      delegate(db, {
        run: childRun,
        request: { targetAgentId: parentAgent.id, taskDescription: "Please do the research for me instead." },
        providers: testProviders,
        autoRetries: 1,
      }),
    ).rejects.toThrow("can’t delegate again");
  });

  it("allows one child per task: a second, different request gets the first child back", async () => {
    const { taskId } = await setup();
    const { executor } = team({
      parent: async (input) => {
        const tool = input.tools.find((candidate) => candidate.name === "delegate_to_agent")!;
        await tool.invoke({ targetAgentId: writerId, taskDescription: REQUEST });
        const second = await tool.invoke({ targetAgentId: writerId, taskDescription: "Write a completely different report about D and E." });
        return answer(second.text);
      },
    });
    await executor.runOnce();
    expect(await childrenOf(taskId)).toHaveLength(1);
    expect(await delegationsOf(taskId)).toHaveLength(1);
  });

  it("creates one child for a repeated request, even after the parent's run is cut off and retried", async () => {
    const { taskId } = await setup();
    let calls = 0;
    const delegateThenHang: Behave = async (input, signal) => {
      const tool = input.tools.find((candidate) => candidate.name === "delegate_to_agent")!;
      await tool.invoke({ targetAgentId: writerId, taskDescription: REQUEST });
      calls++;
      if (calls === 1) {
        // The abort may already have happened while the tool call was finishing.
        if (signal.aborted) return { status: "aborted" };
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ status: "aborted" })));
      }
      return answer("Delegated again (same request).");
    };
    const { executor } = team({ parent: delegateThenHang });
    const first = executor.runOnce();
    await waitFor(async () => (await childrenOf(taskId)).length === 1);
    executor.abortActiveRuns(); // the worker shuts down mid-run
    await first;
    // A lost work run that only delegated is safe to repeat: the task is queued again.
    expect(await taskRow(taskId)).toMatchObject({ status: "queued" });
    await db.update(runs).set({ notBefore: sql`now()` }).where(eq(runs.taskId, taskId));

    const restarted = team({ parent: delegateThenHang });
    await restarted.executor.runOnce(); // the child (oldest) runs and completes
    await restarted.executor.runOnce(); // the retried parent asks again: same request, same child, result given at once
    expect(await childrenOf(taskId)).toHaveLength(1);
    expect(await delegationsOf(taskId)).toHaveLength(1);
    expect(await taskRow(taskId)).toMatchObject({ status: "completed", result: "Delegated again (same request)." });
  });

  it("never offers delegation in a conversation, even to an agent with targets", async () => {
    const { researcher: parentAgent } = await setup();
    const { conversationId } = await conversations.sendMessage({ agentId: parentAgent.id, content: "Hello" });
    const { executor, parentInputs } = team();
    // The task from setup is older; cancel it so the conversation run is next.
    await db.update(runs).set({ status: "cancelled" }).where(sql`${runs.taskId} is not null`);
    await executor.runOnce();
    expect(parentInputs[0].tools).toEqual([]);
    expect((await conversations.get(conversationId)).messages).toHaveLength(2);
  });

  it("keeps each agent's tools to itself: the parent doesn't get the child's tools, and vice versa", async () => {
    const { researcher: parentAgent, writer, taskId } = await setup();
    await db.insert(agentToolPermissions).values([
      { agentId: writer.id, toolId: "look_up", mode: "allow" },
      { agentId: parentAgent.id, toolId: "send_note", mode: "allow" },
    ]);
    const { executor, parentInputs, childInputs } = team();
    await executor.runOnce();
    await executor.runOnce();
    await executor.runOnce();
    expect(parentInputs[0].tools.map((tool) => tool.name).sort()).toEqual(["delegate_to_agent", "send_note"]);
    expect(childInputs[0].tools.map((tool) => tool.name)).toEqual(["look_up"]);
    expect(parentInputs[1].tools.map((tool) => tool.name)).toEqual(["send_note"]);
    expect((await taskRow(taskId)).status).toBe("completed");
  });
});

describe("failures, cancellation, and approvals", () => {
  it("a failed child lets the parent finish with that knowledge, once", async () => {
    const { taskId } = await setup();
    const { executor, parentInputs } = team({
      child: async () => ({ status: "failed", code: "provider_error", message: "Claude returned an error." }),
    });
    await executor.runOnce();
    await executor.runOnce();
    const [child] = await childrenOf(taskId);
    expect(await taskRow(child.id)).toMatchObject({ status: "failed" });
    expect((await delegationsOf(taskId))[0]).toMatchObject({ status: "failed" });
    await executor.runOnce();
    expect(parentInputs[1].prompt).toContain("Writing Assistant’s task failed: Claude returned an error.");
    expect(await taskRow(taskId)).toMatchObject({ status: "completed", result: "FINAL without the delegated result" });
    // The failed child can't be retried on its own: its parent has moved on.
    await expect(service.retry(child.id)).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("a child that hits the usage limit isn't retried; the parent is told", async () => {
    const { taskId } = await setup();
    const { executor, childInputs, parentInputs } = team({
      child: async () => ({ status: "failed", code: "usage_limit", message: "You’ve reached your Claude usage limit." }),
    });
    await executor.runOnce();
    await executor.runOnce();
    await executor.runOnce();
    expect(childInputs).toHaveLength(1);
    expect(parentInputs[1].prompt).toContain("usage limit");
    expect((await taskRow(taskId)).status).toBe("completed");
  });

  it("cancelling the parent cancels its waiting child, which then never runs", async () => {
    const { taskId } = await setup();
    const { executor, childInputs } = team();
    await executor.runOnce();
    expect((await taskRow(taskId)).status).toBe("waiting_on_delegate");

    await service.cancel(taskId);
    const [child] = await childrenOf(taskId);
    expect(await taskRow(taskId)).toMatchObject({ status: "cancelled" });
    expect(await taskRow(child.id)).toMatchObject({ status: "cancelled" });
    expect((await delegationsOf(taskId))[0]).toMatchObject({ status: "cancelled" });
    expect(await executor.runOnce()).toBe(false);
    expect(childInputs).toHaveLength(0);
  });

  it("cancelling the parent stops a running child through the worker", async () => {
    const { taskId } = await setup();
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const { executor } = team({
      child: (_input, signal) => {
        started();
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ status: "aborted" })));
      },
    });
    await executor.runOnce();
    const childRun = executor.runOnce();
    await running;
    await service.cancel(taskId);
    await childRun;
    const [child] = await childrenOf(taskId);
    expect(await taskRow(child.id)).toMatchObject({ status: "cancelled" });
    expect(await taskRow(taskId)).toMatchObject({ status: "cancelled" });
  });

  it("cancelling the child lets the waiting parent continue without it", async () => {
    const { taskId } = await setup();
    const { executor, parentInputs, childInputs } = team();
    await executor.runOnce();
    const [child] = await childrenOf(taskId);
    await service.cancel(child.id);
    expect(await taskRow(child.id)).toMatchObject({ status: "cancelled" });
    expect(await taskRow(taskId)).toMatchObject({ status: "queued" });
    await executor.runOnce();
    expect(childInputs).toHaveLength(0);
    expect(parentInputs[1].prompt).toContain("was cancelled by the owner");
    expect(await taskRow(taskId)).toMatchObject({ status: "completed" });
  });

  it("an interrupted child keeps the parent waiting until the owner retries it", async () => {
    const { taskId } = await setup();
    const { executor } = team();
    await executor.runOnce();
    const [child] = await childrenOf(taskId);
    // The child's worker crashes twice: the automatic retry is used, then it's interrupted.
    for (let crash = 0; crash < 2; crash++) {
      await db.update(runs).set({ notBefore: sql`now()` }).where(eq(runs.taskId, child.id));
      await executor.claimNextRun();
      await db.update(runs).set({ heartbeatAt: sql`now() - interval '1 minute'` }).where(eq(runs.status, "running"));
      await executor.recoverStaleRuns();
    }
    expect(await taskRow(child.id)).toMatchObject({ status: "interrupted" });
    expect(await taskRow(taskId)).toMatchObject({ status: "waiting_on_delegate" });
    expect(await eventTypes(taskId)).toContain("delegate_finished"); // "…was interrupted. Retry or cancel it…"

    await service.retry(child.id);
    await executor.runOnce(); // child
    await executor.runOnce(); // parent follow-up
    expect(await taskRow(taskId)).toMatchObject({ status: "completed" });
  });

  it("the child's sensitive actions still need approval; a rejected one never runs", async () => {
    const { writer, taskId } = await setup();
    await db.insert(agentToolPermissions).values({ agentId: writer.id, toolId: "send_note", mode: "ask" });
    const { executor } = team({
      child: async (input) => {
        const outcome = await input.tools[0].invoke({ text: "to everyone" });
        return answer(outcome.isError ? "Not sent." : "Sent.");
      },
    });
    await executor.runOnce();
    const childRun = executor.runOnce();
    const call = await waitFor(async () => (await db.select().from(toolCalls).where(eq(toolCalls.status, "awaiting_approval")))[0]);
    // The parent's page shows the child's request too.
    expect((await service.get(taskId)).delegations[0].waitingCalls.map((waiting) => waiting.id)).toEqual([call.id]);
    await conversations.decideToolCall(call.id, "reject");
    await childRun;
    expect(toolRuns).toEqual([]);
    const [child] = await childrenOf(taskId);
    expect(await taskRow(child.id)).toMatchObject({ status: "completed", result: "Not sent." });
  });

  it("a worker restart keeps the parent waiting and the link intact", async () => {
    const { taskId } = await setup();
    await team().executor.runOnce();
    const restarted = team();
    expect(await restarted.executor.recoverStaleRuns()).toBe(0);
    expect(await taskRow(taskId)).toMatchObject({ status: "waiting_on_delegate" });
    await restarted.executor.runOnce();
    await restarted.executor.runOnce();
    expect(await taskRow(taskId)).toMatchObject({ status: "completed" });
  });

  it("stops a child left running after its parent stopped (a crash between the two steps)", async () => {
    const { taskId } = await setup();
    const { executor } = team();
    await executor.runOnce();
    const [child] = await childrenOf(taskId);
    // As if the parent's cancel committed but the worker died before stopping the child.
    await db.update(taskDelegations).set({ status: "cancelled" }).where(eq(taskDelegations.childTaskId, child.id));
    await db.update(tasks).set({ status: "cancelled" }).where(eq(tasks.id, taskId));
    await executor.recoverStaleRuns();
    expect(await taskRow(child.id)).toMatchObject({ status: "cancelled" });
  });
});

describe("listing and reading delegated tasks", () => {
  it("shows the link both ways", async () => {
    const { taskId } = await setup();
    const { executor } = team();
    await executor.runOnce();
    await executor.runOnce();
    await executor.runOnce();
    const [child] = await childrenOf(taskId);

    const parentDetail = await service.get(taskId);
    expect(parentDetail.parent).toBeNull();
    expect(parentDetail.delegations).toMatchObject([
      {
        status: "completed",
        taskDescription: REQUEST,
        agent: { name: "Writing Assistant" },
        child: { id: child.id, status: "completed", result: "REPORT: A fast; B safe; C cheap." },
      },
    ]);
    const childDetail = await service.get(child.id);
    expect(childDetail.parent).toMatchObject({ task: { id: taskId }, agent: { name: "Research Assistant" } });
    expect(childDetail.delegations).toEqual([]);

    const listed = await service.list();
    expect(listed.find((task) => task.id === child.id)).toMatchObject({ parentTaskId: taskId, delegatedBy: "Research Assistant" });
    expect(listed.find((task) => task.id === taskId)).toMatchObject({ parentTaskId: null, delegatedBy: null });
  });
});

describe("delegation settings in the agent service", () => {
  it("saves, reads, replaces, and copies targets; refuses self and unknown agents", async () => {
    const writer = await insertAgent(db, { name: "Writing Assistant" });
    const editor = await insertAgent(db, { name: "Editor" });
    const lead = await agentService.create({ name: "Lead", role: "lead", instructions: "Lead.", delegateTo: [writer.id] });
    expect((await agentService.getDelegationTargets(lead.id)).map((target) => target.name)).toEqual(["Writing Assistant"]);

    await agentService.update(lead.id, { delegateTo: [editor.id, writer.id] });
    expect((await agentService.getDelegationTargets(lead.id)).map((target) => target.name)).toEqual(["Editor", "Writing Assistant"]);
    await expect(agentService.update(lead.id, { delegateTo: [lead.id] })).rejects.toMatchObject({
      fieldErrors: { delegateTo: ["An agent can’t delegate to itself."] },
    });
    await expect(agentService.update(lead.id, { delegateTo: [crypto.randomUUID()] })).rejects.toMatchObject({
      code: "validation_failed",
    });
    // The delegation tool can't be switched on as an ordinary tool.
    await expect(agentService.update(lead.id, { tools: [{ toolId: "delegate_to_agent", mode: "allow" }] })).rejects.toMatchObject({
      code: "validation_failed",
    });

    const copy = await agentService.duplicate(lead.id);
    expect((await agentService.getDelegationTargets(copy.id)).map((target) => target.name)).toEqual(["Editor", "Writing Assistant"]);
    await agentService.update(lead.id, { delegateTo: [] });
    expect(await agentService.getDelegationTargets(lead.id)).toEqual([]);
  });
});
