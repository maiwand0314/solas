import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { agents, conversations, messages, runs, type RunRow, type RunStatus } from "@/server/db/schema";
import { truncate, type Logger } from "@/server/logger";
import { getAgentReadiness, type ProviderRegistry } from "@/server/providers/registry";
import type { AgentRuntime, RunUsage } from "@/server/runtime/types";
import { RUN_LIMITS } from "./config";
import { buildPrompt } from "./prompt";

// The worker's side of a run: claim a pending run, load the agent from
// PostgreSQL, call the agent's provider through the AgentRuntime interface,
// and record the outcome. The same code runs every agent; nothing here knows
// any agent by name.

type Outcome =
  | { status: "completed"; text: string; usage: RunUsage }
  | { status: "failed"; code: string; message: string }
  | { status: "cancelled" };

type Dependencies = {
  db: Database;
  providers: ProviderRegistry;
  /** One runtime per provider ID. */
  runtimes: AgentRuntime[];
  log: Logger;
  limits?: { timeoutMs: number; cancelCheckMs: number; historyMessages: number; historyCharacters: number };
};

export function createRunExecutor({ db, providers, runtimes, log, limits = RUN_LIMITS }: Dependencies) {
  const runtimeFor = new Map(runtimes.map((runtime) => [runtime.providerId, runtime]));
  // The run in progress, so a shutdown can stop it. One at a time by design.
  let stopActiveRun: ((reason: StopReason) => void) | null = null;

  /**
   * Runs left "running" by a worker that crashed or was killed can't be
   * finished, so they're marked failed. Safe because there is one worker.
   */
  async function recoverInterruptedRuns(): Promise<number> {
    const recovered = await db
      .update(runs)
      .set({
        status: "failed",
        errorCode: "worker_stopped",
        errorMessage: "The worker stopped while this reply was being written. Send your message again.",
        finishedAt: sql`now()`,
      })
      .where(eq(runs.status, "running"))
      .returning({ id: runs.id });
    return recovered.length;
  }

  /**
   * Takes the oldest pending run and marks it running, atomically. SKIP
   * LOCKED means a second worker would take a different run instead of
   * waiting, so the same run can never be executed twice.
   *
   * The subquery is compared with `=`, not `IN`, on purpose. With `IN`,
   * PostgreSQL may plan a semi-join that re-runs the subquery for every row,
   * so "LIMIT 1" no longer holds and one claim marks several runs running.
   * A scalar subquery runs exactly once. (A claim made at the very same
   * moment as another can still come back empty; the next poll picks up
   * whatever it skipped.)
   */
  async function claimNextRun(): Promise<RunRow | null> {
    const oldestPending = db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.status, "pending"))
      .orderBy(asc(runs.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    const [run] = await db
      .update(runs)
      .set({ status: "running", startedAt: sql`now()` })
      .where(and(sql`${runs.id} = (${oldestPending})`, eq(runs.status, "pending")))
      .returning();
    return run ?? null;
  }

  /** Claims and executes one run. Returns false when there was nothing to do. */
  async function runOnce(): Promise<boolean> {
    const run = await claimNextRun();
    if (!run) return false;
    await executeRun(run);
    return true;
  }

  async function executeRun(run: RunRow): Promise<RunStatus> {
    const startedAt = Date.now();
    const fields = { runId: run.id, agentId: run.agentId, conversationId: run.conversationId };
    log("info", "run.started", fields);

    let outcome: Outcome;
    try {
      outcome = await perform(run);
    } catch (error) {
      log("error", "run.crashed", { ...fields, error: truncate(error instanceof Error ? error.message : String(error)) });
      outcome = { status: "failed", code: "unexpected", message: "Something went wrong in the worker. Check its log." };
    }

    const saved = await finish(run, outcome);
    log(outcome.status === "failed" ? "warn" : "info", "run.finished", {
      ...fields,
      status: outcome.status,
      errorCode: outcome.status === "failed" ? outcome.code : undefined,
      inputTokens: outcome.status === "completed" ? outcome.usage.inputTokens : undefined,
      outputTokens: outcome.status === "completed" ? outcome.usage.outputTokens : undefined,
      durationMs: Date.now() - startedAt,
      saved,
    });
    return outcome.status;
  }

  async function perform(run: RunRow): Promise<Outcome> {
    // Load the agent fresh: it may have changed since the message was sent.
    const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId)).limit(1);
    if (!agent) return failed("agent_unavailable", "The agent was deleted before it could answer.");
    const readiness = getAgentReadiness(agent, providers);
    if (readiness.state === "disabled") {
      return failed("agent_unavailable", `“${agent.name}” was disabled before it could answer.`);
    }
    if (readiness.state === "unconfigured") {
      return failed("agent_unavailable", `“${agent.name}” can’t answer: ${readiness.reason}`);
    }
    const runtime = runtimeFor.get(agent.providerId!);
    if (!runtime) return failed("runtime_unavailable", "This worker can’t run the agent’s provider.");

    const prompt = await promptFor(run);
    await db.update(runs).set({ modelId: agent.modelId }).where(eq(runs.id, run.id));

    const controller = new AbortController();
    let stopReason: StopReason | null = null;
    const stop = (reason: StopReason) => {
      stopReason ??= reason;
      controller.abort();
    };
    const timer = setTimeout(() => stop("timeout"), limits.timeoutMs);
    const cancelWatcher = setInterval(() => {
      db.select({ cancelRequestedAt: runs.cancelRequestedAt })
        .from(runs)
        .where(eq(runs.id, run.id))
        .then(([row]) => {
          if (row?.cancelRequestedAt) stop("cancelled");
        })
        .catch(() => {}); // A missed check is retried a second later.
    }, limits.cancelCheckMs);
    stopActiveRun = stop;

    try {
      const result = await runtime.run(
        { systemPrompt: agent.instructions, prompt, model: agent.modelId! },
        controller.signal,
      );
      if (result.status === "completed") return result;
      if (result.status === "failed") {
        if (result.retryAt) log("info", "run.retry_after", { runId: run.id, retryAt: result.retryAt.toISOString() });
        return failed(result.code, result.message);
      }
      return stopped(stopReason ?? "cancelled");
    } finally {
      clearTimeout(timer);
      clearInterval(cancelWatcher);
      stopActiveRun = null;
    }
  }

  async function promptFor(run: RunRow): Promise<string> {
    const history = await db
      .select({ id: messages.id, role: messages.role, content: messages.content })
      .from(messages)
      .where(eq(messages.conversationId, run.conversationId))
      .orderBy(asc(messages.createdAt));
    const index = history.findIndex((message) => message.id === run.userMessageId);
    if (index === -1) throw new Error("The run's message is missing.");
    return buildPrompt(history.slice(0, index), history[index].content, limits);
  }

  function stopped(reason: StopReason): Outcome {
    if (reason === "timeout") {
      const minutes = Math.round(limits.timeoutMs / 60_000);
      return failed("timeout", `No reply within ${minutes} ${minutes === 1 ? "minute" : "minutes"}, so the run was stopped.`);
    }
    if (reason === "shutdown") {
      return failed("worker_stopped", "The worker was stopped while this reply was being written. Send your message again.");
    }
    return { status: "cancelled" };
  }

  /**
   * Records the outcome. Updates only a run that is still "running", so a
   * run that was deleted (with its agent or conversation) is left alone.
   */
  async function finish(run: RunRow, outcome: Outcome): Promise<boolean> {
    return db.transaction(async (tx) => {
      const stillRunning = and(eq(runs.id, run.id), eq(runs.status, "running"));
      if (outcome.status === "completed") {
        const [updated] = await tx
          .update(runs)
          .set({
            status: "completed",
            finishedAt: sql`now()`,
            inputTokens: outcome.usage.inputTokens,
            outputTokens: outcome.usage.outputTokens,
          })
          .where(stillRunning)
          .returning({ id: runs.id });
        if (!updated) return false;
        await tx
          .insert(messages)
          .values({ conversationId: run.conversationId, role: "assistant", content: outcome.text, runId: run.id });
        await tx.update(conversations).set({ updatedAt: sql`now()` }).where(eq(conversations.id, run.conversationId));
        return true;
      }
      const [updated] = await tx
        .update(runs)
        .set({
          status: outcome.status,
          errorCode: outcome.status === "failed" ? outcome.code : null,
          errorMessage: outcome.status === "failed" ? outcome.message : null,
          finishedAt: sql`now()`,
        })
        .where(stillRunning)
        .returning({ id: runs.id });
      return Boolean(updated);
    });
  }

  /** Stops the run in progress, if any (used when the worker shuts down). */
  function abortActiveRun() {
    stopActiveRun?.("shutdown");
  }

  return { recoverInterruptedRuns, claimNextRun, runOnce, executeRun, abortActiveRun };
}

type StopReason = "timeout" | "cancelled" | "shutdown";

function failed(code: string, message: string): Outcome {
  return { status: "failed", code, message };
}

export type RunExecutor = ReturnType<typeof createRunExecutor>;
