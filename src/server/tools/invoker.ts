import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { setTimeout as sleep } from "node:timers/promises";
import type { z } from "zod";
import type { Database } from "@/server/db/client";
import { agentDelegationTargets, agents, agentToolPermissions, toolCalls, type ToolCallStatus } from "@/server/db/schema";
import { truncate, type Logger } from "@/server/logger";
import type { RuntimeTool, ToolCallOutcome } from "@/server/runtime/types";
import type { ToolRegistry } from "./registry";
import { ToolError, type AnyToolDefinition, type ToolContext } from "./types";
import { ensureWorkspace } from "./workspace";

// The permission enforcement layer. Every tool call an agent makes goes
// through invoke(), in the worker, before anything runs:
//
//   1. permission  — read again from PostgreSQL: is this tool enabled for
//                    this agent right now?
//   2. validation  — the input must match the tool's Zod schema exactly
//   3. approval    — if needed, wait for the owner's decision (or expiry)
//   4. execution   — with the tool's time limit, inside the agent's workspace
//   5. contract    — the result must match the tool's output schema
//   6. record      — every outcome is saved in tool_calls
//
// The model only ever sees the text result. It can't skip a step: the steps
// are Solas code, and the model's only power is to ask.

export type ToolLimits = {
  /** How long an approval request waits for the owner. */
  approvalTtlMs: number;
  /** How often a waiting call checks for the owner's decision. */
  approvalPollMs: number;
};

export type RunToolContext = {
  runId: string;
  agentId: string;
  /** Aborted on Stop, timeout, or shutdown. */
  signal: AbortSignal;
  /** Called with true while a call waits for approval (the run's clock pauses), false after. */
  onApprovalWait?: (waiting: boolean) => void;
  /**
   * Told about each step of every call (requested, approval, result), for a
   * task's timeline. Awaited, so events are recorded in the order they happen.
   */
  onEvent?: (event: ToolEvent) => Promise<void>;
  /**
   * Set only for a task run that may delegate (M5A). Without it the
   * delegation tool isn't offered, and a call to it is refused.
   */
  delegate?: ToolContext["delegate"];
};

/** One step of a tool call, described with Solas's own summaries (never raw output). */
export type ToolEvent = {
  type:
    | "tool_requested"
    | "tool_denied"
    | "approval_requested"
    | "approval_granted"
    | "approval_rejected"
    | "approval_expired"
    | "approval_cancelled"
    | "tool_succeeded"
    | "tool_failed";
  toolId: string;
  toolName: string;
  toolCallId: string;
  /** The one-line input summary, e.g. "notes/plan.md". */
  summary: string;
  /** The result summary or the error, when there is one. */
  detail?: string;
};

type Dependencies = {
  db: Database;
  registry: ToolRegistry;
  log: Logger;
  limits: ToolLimits;
  /** Creates (if needed) and returns the agent's workspace. Tests pass their own. */
  workspaceFor?: (agentId: string) => Promise<string>;
};

/** Inputs larger than this aren't stored for refused calls (they never ran). */
const MAX_STORED_RAW_INPUT = 2_000;

export function createToolInvoker({ db, registry, log, limits, workspaceFor = ensureWorkspace }: Dependencies) {
  /** The tools this agent may use in this run, ready to hand to the runtime. */
  async function toolsForRun(context: RunToolContext): Promise<RuntimeTool[]> {
    const permitted = await db
      .select({ toolId: agentToolPermissions.toolId })
      .from(agentToolPermissions)
      .where(eq(agentToolPermissions.agentId, context.agentId));
    const tools = permitted
      .map(({ toolId }) => registry.get(toolId))
      .filter((tool): tool is AnyToolDefinition => tool !== undefined && (tool.grantedBy ?? "permissions") === "permissions")
      .map((tool) => runtimeTool(tool, tool.description, context));

    // Delegation (M5A): only in runs allowed to delegate, and only if the owner chose targets.
    const delegation = registry.list().find((tool) => tool.grantedBy === "delegation");
    if (delegation && context.delegate) {
      const targets = await delegationTargets(context.agentId);
      if (targets.length > 0) {
        const list = targets.map((target) => `- ${target.id}: ${target.name}${target.role ? ` (${target.role})` : ""}`).join("\n");
        tools.push(runtimeTool(delegation, `${delegation.description}\n\nAgents you may delegate to:\n${list}`, context));
      }
    }
    return tools;
  }

  function runtimeTool(tool: AnyToolDefinition, description: string, context: RunToolContext): RuntimeTool {
    return { name: tool.id, description, inputShape: tool.input.shape, invoke: (input: unknown) => invoke(tool, input, context) };
  }

  /** The agents this agent may delegate to (enabled ones only), read fresh. */
  async function delegationTargets(agentId: string) {
    return db
      .select({ id: agents.id, name: agents.name, role: agents.role })
      .from(agentDelegationTargets)
      .innerJoin(agents, eq(agents.id, agentDelegationTargets.targetAgentId))
      .where(and(eq(agentDelegationTargets.agentId, agentId), eq(agents.enabled, true)));
  }

  /** The agent's permission for a tool right now: its mode, or null when it isn't allowed. */
  async function permissionFor(tool: AnyToolDefinition, context: RunToolContext): Promise<"allow" | "ask" | null> {
    if (tool.grantedBy === "delegation") {
      // Granted by delegation targets, in a run allowed to delegate. Which target is checked by the delegation itself.
      const [target] = await db
        .select({ id: agentDelegationTargets.targetAgentId })
        .from(agentDelegationTargets)
        .where(eq(agentDelegationTargets.agentId, context.agentId))
        .limit(1);
      return context.delegate && target ? "allow" : null;
    }
    const [permission] = await db
      .select({ mode: agentToolPermissions.mode })
      .from(agentToolPermissions)
      .where(and(eq(agentToolPermissions.agentId, context.agentId), eq(agentToolPermissions.toolId, tool.id)))
      .limit(1);
    return permission?.mode ?? null;
  }

  async function invoke(tool: AnyToolDefinition, rawInput: unknown, context: RunToolContext): Promise<ToolCallOutcome> {
    const started = Date.now();
    const fields = { runId: context.runId, toolId: tool.id };
    const emit = async (type: ToolEvent["type"], toolCallId: string, summary: string, detail?: string) => {
      try {
        await context.onEvent?.({ type, toolId: tool.id, toolName: tool.name, toolCallId, summary, detail });
      } catch (error) {
        // The timeline is a record, not a gate: a failed write never blocks the call's own checks.
        log("warn", "tool.event_not_recorded", { ...fields, type, error: truncate(error instanceof Error ? error.message : String(error)) });
      }
    };

    // 1. Permission, read fresh: a change in Agent Builder applies at once.
    const mode = await permissionFor(tool, context);
    if (!mode) {
      const deniedId = await insertCall(context.runId, tool, storableRaw(rawInput), "—", "denied", {
        errorMessage: "Not enabled for this agent.",
      });
      log("warn", "tool.denied", fields);
      await emit("tool_denied", deniedId, "—", "Not enabled for this agent.");
      return failure(`${tool.name} is not enabled for this agent, so it was not run.`);
    }

    // 2. Validation against the tool's own schema.
    const schema: z.ZodObject = tool.input;
    const parsed = schema.safeParse(rawInput);
    if (!parsed.success) {
      const problem = parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
      const invalidId = await insertCall(context.runId, tool, storableRaw(rawInput), "invalid input", "failed", {
        errorMessage: truncate(`Invalid input: ${problem}`, 300),
      });
      await emit("tool_failed", invalidId, "invalid input", "The input didn’t match the tool’s rules, so it didn’t run.");
      return failure(`Invalid input for ${tool.id}: ${problem}`);
    }
    const input: unknown = parsed.data;
    const summary = truncate(tool.summarizeInput(input), 200);

    // 3. Approval, when the tool or the agent's setting asks for it.
    const needsApproval = tool.approval === "required" || mode === "ask";
    const callId = await insertCall(context.runId, tool, input, summary, needsApproval ? "awaiting_approval" : "running", {
      requiresApproval: needsApproval,
      approvalExpiresAt: needsApproval ? new Date(Date.now() + limits.approvalTtlMs) : null,
    });
    await emit("tool_requested", callId, summary);
    if (needsApproval) {
      log("info", "tool.approval_requested", { ...fields, callId });
      await emit("approval_requested", callId, summary);
      const decision = await waitForDecision(callId, context);
      log("info", "tool.approval_decided", { ...fields, callId, decision });
      await emit(DECISION_EVENTS[decision], callId, summary);
      if (decision !== "approved") return failure(DECISION_MESSAGES[decision]);
      // Run exactly the input the owner approved, and only once.
      const [running] = await db
        .update(toolCalls)
        .set({ status: "running" })
        .where(and(eq(toolCalls.id, callId), eq(toolCalls.status, "approved")))
        .returning({ id: toolCalls.id });
      if (!running) return failure(DECISION_MESSAGES.cancelled);
    }

    // 4–5. Execution with the tool's time limit, then the output contract.
    const timeLimit = AbortSignal.timeout(tool.timeoutMs);
    const signal = AbortSignal.any([context.signal, timeLimit]);
    try {
      // Only file tools get (and create) the agent's workspace folder.
      const workspaceDir = tool.capability === "workspace-read" ? await workspaceFor(context.agentId) : "";
      const output = tool.output.parse(
        await abortable(tool.execute(input, { workspaceDir, signal, delegate: context.delegate }), signal),
      );
      const text = JSON.stringify(output);
      const resultSummary = truncate(tool.summarizeOutput(output), 200);
      await finishCall(callId, "succeeded", { resultSummary });
      log("info", "tool.succeeded", { ...fields, callId, durationMs: Date.now() - started });
      await emit("tool_succeeded", callId, summary, resultSummary);
      return { text: truncate(text, tool.maxOutputChars), isError: false };
    } catch (error) {
      const message =
        error instanceof ToolError
          ? error.message
          : timeLimit.aborted
            ? `${tool.name} took longer than ${tool.timeoutMs / 1000} s and was stopped.`
            : context.signal.aborted
              ? "The run was stopped."
              : `${tool.name} failed.`;
      if (!(error instanceof ToolError)) {
        log("error", "tool.crashed", { ...fields, callId, error: truncate(error instanceof Error ? error.message : String(error)) });
      }
      await finishCall(callId, "failed", { errorMessage: message });
      await emit("tool_failed", callId, summary, message);
      return failure(message);
    }
  }

  /**
   * Waits until the owner approves or rejects, the request expires, or the
   * run is stopped. Expiry is decided by the database clock, the same one
   * the web app uses to refuse a late decision.
   */
  async function waitForDecision(callId: string, context: RunToolContext): Promise<Decision> {
    context.onApprovalWait?.(true);
    try {
      while (true) {
        if (context.signal.aborted) {
          const [cancelled] = await db
            .update(toolCalls)
            .set({ status: "cancelled", finishedAt: sql`now()` })
            .where(and(eq(toolCalls.id, callId), eq(toolCalls.status, "awaiting_approval")))
            .returning({ id: toolCalls.id });
          if (cancelled) return "cancelled";
        }
        const [row] = await db
          .select({ status: toolCalls.status, due: sql<boolean>`${toolCalls.approvalExpiresAt} <= now()` })
          .from(toolCalls)
          .where(eq(toolCalls.id, callId));
        if (!row) return "cancelled"; // deleted with its conversation
        if (row.status === "approved" || row.status === "rejected" || row.status === "expired") return row.status;
        if (row.status === "cancelled") return "cancelled";
        if (row.due) {
          const [expired] = await db
            .update(toolCalls)
            .set({ status: "expired", finishedAt: sql`now()` })
            .where(and(eq(toolCalls.id, callId), eq(toolCalls.status, "awaiting_approval")))
            .returning({ id: toolCalls.id });
          if (expired) return "expired";
          continue; // decided at the last moment: read it again
        }
        await sleep(limits.approvalPollMs);
      }
    } finally {
      context.onApprovalWait?.(false);
    }
  }

  async function insertCall(
    runId: string,
    tool: AnyToolDefinition,
    input: unknown,
    inputSummary: string,
    status: ToolCallStatus,
    extra: Partial<typeof toolCalls.$inferInsert> = {},
  ): Promise<string> {
    const finished = status === "denied" || status === "failed";
    const [row] = await db
      .insert(toolCalls)
      .values({ runId, toolId: tool.id, input, inputSummary, status, finishedAt: finished ? sql`now()` : null, ...extra })
      .returning({ id: toolCalls.id });
    return row.id;
  }

  async function finishCall(callId: string, status: "succeeded" | "failed", extra: Partial<typeof toolCalls.$inferInsert>) {
    await db
      .update(toolCalls)
      .set({ status, finishedAt: sql`now()`, ...extra })
      .where(and(eq(toolCalls.id, callId), eq(toolCalls.status, "running")));
  }

  return { toolsForRun, invoke };
}

type Decision = "approved" | "rejected" | "expired" | "cancelled";

const DECISION_EVENTS: Record<Decision, ToolEvent["type"]> = {
  approved: "approval_granted",
  rejected: "approval_rejected",
  expired: "approval_expired",
  cancelled: "approval_cancelled",
};

/** What the model is told when a call doesn't run. */
const DECISION_MESSAGES: Record<Exclude<Decision, "approved">, string> = {
  rejected: "The owner rejected this action, so it was not run. Don't try it again unless the owner asks.",
  expired: "The owner didn't approve this action in time, so it was not run.",
  cancelled: "The run was stopped before this action was approved, so it was not run.",
};

function failure(text: string): ToolCallOutcome {
  return { text, isError: true };
}

/** A refused call's input, kept for the record only if it is small and plain JSON. */
function storableRaw(input: unknown): unknown {
  try {
    const json = JSON.stringify(input ?? {});
    return json.length <= MAX_STORED_RAW_INPUT ? JSON.parse(json) : { omitted: "input too large to store" };
  } catch {
    return { omitted: "input not storable" };
  }
}

/** Rejects as soon as the signal aborts, even if the work itself ignores it. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export type ToolInvoker = ReturnType<typeof createToolInvoker>;
