import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationService } from "@/server/conversations/service";
import { ConversationServiceError } from "@/server/conversations/errors";
import { closeDatabase, createDatabase } from "@/server/db/client";
import { agents, agentToolPermissions, toolCalls } from "@/server/db/schema";
import type { Logger } from "@/server/logger";
import { insertAgent, testProviders } from "@/server/runs/test-helpers";
import type { RuntimeTool } from "@/server/runtime/types";
import { readWorkspaceFileTool } from "./builtin/workspace-files";
import { createToolInvoker, type RunToolContext, type ToolLimits } from "./invoker";
import { createToolRegistry } from "./registry";
import { ToolError, type AnyToolDefinition } from "./types";

// The permission enforcement layer against the test database. Test tools
// count their executions, so each test can prove what did and didn't run.

const db = createDatabase(process.env.TEST_DATABASE_URL!);
const conversations = createConversationService({ db, providers: testProviders });
const log = vi.fn<Logger>();
const limits: ToolLimits = { approvalTtlMs: 5_000, approvalPollMs: 10 };

let executions: unknown[] = [];
function testTool(overrides: Partial<AnyToolDefinition> = {}): AnyToolDefinition {
  return {
    id: "echo",
    name: "Echo",
    description: "Returns its input.",
    input: z.strictObject({ text: z.string().max(20) }),
    output: z.strictObject({ echoed: z.string() }),
    risk: "low",
    approval: "optional",
    capability: "none",
    defaultMode: "allow",
    timeoutMs: 1_000,
    maxOutputChars: 1_000,
    summarizeInput: (input: { text: string }) => input.text,
    summarizeOutput: (output: { echoed: string }) => `echoed ${output.echoed}`,
    async execute(input: { text: string }) {
      executions.push(input);
      return { echoed: input.text };
    },
    ...overrides,
  };
}

const registry = createToolRegistry([
  testTool(),
  testTool({ id: "slow", name: "Slow", timeoutMs: 50, execute: () => new Promise(() => {}) }),
  testTool({
    id: "broken",
    name: "Broken",
    execute: async () => {
      throw new Error("ENOENT /Users/owner/.ssh/id_rsa");
    },
  }),
  testTool({
    id: "refusing",
    name: "Refusing",
    execute: async () => {
      throw new ToolError("That file is too large.");
    },
  }),
  testTool({ id: "liar", name: "Liar", execute: async () => ({ unexpected: true }) as never }),
  testTool({ id: "strict", name: "Strict", approval: "required", defaultMode: "ask" }),
  readWorkspaceFileTool,
]);

let workspace: string;
const invoker = (overrides: Partial<ToolLimits> = {}) =>
  createToolInvoker({ db, registry, log, limits: { ...limits, ...overrides }, workspaceFor: async () => workspace });

async function setup(permissions: { toolId: string; mode: "allow" | "ask" }[]) {
  const agent = await insertAgent(db, { name: `Agent ${randomUUID().slice(0, 8)}` });
  if (permissions.length > 0) {
    await db.insert(agentToolPermissions).values(permissions.map((permission) => ({ agentId: agent.id, ...permission })));
  }
  const { runId } = await conversations.sendMessage({ agentId: agent.id, content: "Use a tool" });
  const controller = new AbortController();
  const waits: boolean[] = [];
  const context: RunToolContext = {
    runId,
    agentId: agent.id,
    signal: controller.signal,
    onApprovalWait: (waiting) => waits.push(waiting),
  };
  return { agent, runId, controller, context, waits };
}

const toolNamed = (tools: RuntimeTool[], name: string) => tools.find((tool) => tool.name === name)!;
const callsOf = (runId: string) => db.select().from(toolCalls).where(eq(toolCalls.runId, runId)).orderBy(toolCalls.createdAt);

/** Resolves once the run has a call waiting for approval, and returns it. */
async function waitingCall(runId: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const waiting = (await callsOf(runId)).find((call) => call.status === "awaiting_approval");
    if (waiting) return waiting;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("No call is waiting for approval.");
}

beforeAll(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "solas-invoker-test-"));
  await mkdir(path.join(workspace, "notes"));
  await writeFile(path.join(workspace, "notes", "plan.md"), "The plan.");
});

beforeEach(async () => {
  executions = [];
  log.mockClear();
  await db.delete(agents);
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
  await closeDatabase(db);
});

describe("which tools an agent gets", () => {
  it("offers only the tools enabled for this agent, and none by default", async () => {
    const none = await setup([]);
    expect(await invoker().toolsForRun(none.context)).toEqual([]);

    const some = await setup([{ toolId: "echo", mode: "allow" }]);
    expect((await invoker().toolsForRun(some.context)).map((tool) => tool.name)).toEqual(["echo"]);
    // The other agent's permissions don't leak into this one.
    expect((await invoker().toolsForRun(none.context)).map((tool) => tool.name)).toEqual([]);
  });

  it("ignores a stored permission for a tool that no longer exists", async () => {
    const { context } = await setup([
      { toolId: "echo", mode: "allow" },
      { toolId: "retired_tool", mode: "allow" },
    ]);
    expect((await invoker().toolsForRun(context)).map((tool) => tool.name)).toEqual(["echo"]);
  });
});

describe("running an allowed tool", () => {
  it("validates, runs, records, and returns the result as text", async () => {
    const { context, runId } = await setup([{ toolId: "echo", mode: "allow" }]);
    const echo = toolNamed(await invoker().toolsForRun(context), "echo");

    expect(await echo.invoke({ text: "hi" })).toEqual({ text: '{"echoed":"hi"}', isError: false });
    expect(executions).toEqual([{ text: "hi" }]);
    expect(await callsOf(runId)).toMatchObject([
      { toolId: "echo", status: "succeeded", input: { text: "hi" }, inputSummary: "hi", resultSummary: "echoed hi" },
    ]);
  });

  it("rejects invalid input without running the tool", async () => {
    const { context, runId } = await setup([{ toolId: "echo", mode: "allow" }]);
    const echo = toolNamed(await invoker().toolsForRun(context), "echo");

    for (const bad of [{ text: 42 }, { text: "x".repeat(21) }, { text: "hi", path: "/etc/passwd" }, "just a string"]) {
      expect((await echo.invoke(bad)).isError).toBe(true);
    }
    expect(executions).toEqual([]);
    expect((await callsOf(runId)).every((call) => call.status === "failed")).toBe(true);
  });
});

describe("permission enforcement", () => {
  it("refuses a call once the tool has been disabled, even mid-run", async () => {
    const { agent, context, runId } = await setup([{ toolId: "echo", mode: "allow" }]);
    const echo = toolNamed(await invoker().toolsForRun(context), "echo");
    await db.delete(agentToolPermissions).where(eq(agentToolPermissions.agentId, agent.id));

    const outcome = await echo.invoke({ text: "hi" });
    expect(outcome).toMatchObject({ isError: true });
    expect(outcome.text).toContain("not enabled");
    expect(executions).toEqual([]);
    expect(await callsOf(runId)).toMatchObject([{ status: "denied" }]);
  });

  it("checks permissions per agent: one agent's tool doesn't work for another", async () => {
    const owner = await setup([{ toolId: "echo", mode: "allow" }]);
    const other = await setup([]);
    const echo = toolNamed(await invoker().toolsForRun(owner.context), "echo");
    // Simulate a call arriving with the other agent's run context.
    const outcome = await invoker().invoke(registry.get("echo")!, { text: "hi" }, other.context);
    expect(outcome.isError).toBe(true);
    expect(executions).toEqual([]);
    expect(echo).toBeDefined();
  });
});

describe("approvals", () => {
  it("waits for the owner, then runs exactly the approved input once", async () => {
    const { context, runId, waits } = await setup([{ toolId: "echo", mode: "ask" }]);
    const echo = toolNamed(await invoker().toolsForRun(context), "echo");

    const pending = echo.invoke({ text: "approve me" });
    const call = await waitingCall(runId);
    expect(call).toMatchObject({ requiresApproval: true, input: { text: "approve me" } });
    expect(executions).toEqual([]); // nothing runs before the decision

    await conversations.decideToolCall(call.id, "approve");
    expect(await pending).toEqual({ text: '{"echoed":"approve me"}', isError: false });
    expect(executions).toEqual([{ text: "approve me" }]);
    expect((await callsOf(runId))[0]).toMatchObject({ status: "succeeded" });
    expect(waits).toEqual([true, false]); // the run's clock paused while waiting
  });

  it("never runs a rejected action, and tells the model not to retry", async () => {
    const { context, runId } = await setup([{ toolId: "echo", mode: "ask" }]);
    const echo = toolNamed(await invoker().toolsForRun(context), "echo");

    const pending = echo.invoke({ text: "reject me" });
    await conversations.decideToolCall((await waitingCall(runId)).id, "reject");
    const outcome = await pending;

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("rejected");
    expect(executions).toEqual([]);
    expect((await callsOf(runId))[0]).toMatchObject({ status: "rejected" });
  });

  it("expires an undecided request, never runs it, and refuses a late decision", async () => {
    const { context, runId } = await setup([{ toolId: "echo", mode: "ask" }]);
    const echo = toolNamed(await invoker({ approvalTtlMs: 100 }).toolsForRun(context), "echo");

    const outcome = await echo.invoke({ text: "too late" });
    expect(outcome.text).toContain("in time");
    expect(executions).toEqual([]);
    const [call] = await callsOf(runId);
    expect(call.status).toBe("expired");

    const late = await conversations.decideToolCall(call.id, "approve").then(
      () => null,
      (error: unknown) => error,
    );
    expect((late as ConversationServiceError).message).toContain("expired");
  });

  it("a tool that always requires approval asks even when the agent says 'allow'", async () => {
    const { context, runId } = await setup([{ toolId: "strict", mode: "allow" }]);
    const strict = toolNamed(await invoker().toolsForRun(context), "strict");

    const pending = strict.invoke({ text: "careful" });
    const call = await waitingCall(runId);
    await conversations.decideToolCall(call.id, "reject");
    await pending;
    expect(executions).toEqual([]);
  });

  it("cancels a waiting request when the run is stopped", async () => {
    const { context, runId, controller } = await setup([{ toolId: "echo", mode: "ask" }]);
    const echo = toolNamed(await invoker().toolsForRun(context), "echo");

    const pending = echo.invoke({ text: "stop me" });
    await waitingCall(runId);
    controller.abort();
    expect((await pending).isError).toBe(true);
    expect((await callsOf(runId))[0]).toMatchObject({ status: "cancelled" });
    expect(executions).toEqual([]);
  });

  it("a decision can't be made twice", async () => {
    const { context, runId } = await setup([{ toolId: "echo", mode: "ask" }]);
    const echo = toolNamed(await invoker().toolsForRun(context), "echo");
    const pending = echo.invoke({ text: "once" });
    const call = await waitingCall(runId);

    await conversations.decideToolCall(call.id, "reject");
    await expect(conversations.decideToolCall(call.id, "approve")).rejects.toThrow(/already decided/);
    await pending;
    expect(executions).toEqual([]);
  });
});

describe("limits and failures", () => {
  it("stops a tool that runs past its time limit", async () => {
    const { context, runId } = await setup([{ toolId: "slow", mode: "allow" }]);
    const outcome = await toolNamed(await invoker().toolsForRun(context), "slow").invoke({ text: "hi" });
    expect(outcome.text).toContain("took longer");
    expect((await callsOf(runId))[0]).toMatchObject({ status: "failed" });
  });

  it("passes a tool's own error message on, but hides unexpected internals", async () => {
    const { context, runId } = await setup([
      { toolId: "refusing", mode: "allow" },
      { toolId: "broken", mode: "allow" },
    ]);
    const tools = await invoker().toolsForRun(context);

    expect((await toolNamed(tools, "refusing").invoke({ text: "hi" })).text).toBe("That file is too large.");
    const crash = await toolNamed(tools, "broken").invoke({ text: "hi" });
    expect(crash.text).toBe("Broken failed.");
    const recorded = JSON.stringify(await callsOf(runId));
    expect(recorded).not.toContain("id_rsa");
    expect(log).toHaveBeenCalledWith("error", "tool.crashed", expect.any(Object));
  });

  it("refuses a result that breaks the tool's output contract", async () => {
    const { context, runId } = await setup([{ toolId: "liar", mode: "allow" }]);
    const outcome = await toolNamed(await invoker().toolsForRun(context), "liar").invoke({ text: "hi" });
    expect(outcome.isError).toBe(true);
    expect((await callsOf(runId))[0]).toMatchObject({ status: "failed" });
  });

  it("keeps file reads inside the workspace, through the whole enforcement path", async () => {
    const { context, runId } = await setup([{ toolId: "read_workspace_file", mode: "allow" }]);
    const read = toolNamed(await invoker().toolsForRun(context), "read_workspace_file");

    expect(JSON.parse((await read.invoke({ path: "notes/plan.md" })).text)).toMatchObject({ content: "The plan." });
    const escape = await read.invoke({ path: "../../../etc/passwd" });
    expect(escape).toMatchObject({ isError: true });
    expect(escape.text).toContain("outside the workspace");
    expect((await callsOf(runId)).map((call) => call.status)).toEqual(["succeeded", "failed"]);
  });
});
