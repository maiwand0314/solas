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

export type ExecutorLimits = {
  timeoutMs: number;
  heartbeatMs: number;
  staleAfterMs: number;
  progressWriteMs: number;
  historyMessages: number;
  historyCharacters: number;
};

type Dependencies = {
  db: Database;
  providers: ProviderRegistry;
  /** One runtime per provider ID. */
  runtimes: AgentRuntime[];
  log: Logger;
  limits?: ExecutorLimits;
};

export function createRunExecutor({ db, providers, runtimes, log, limits = RUN_LIMITS }: Dependencies) {
  const runtimeFor = new Map(runtimes.map((runtime) => [runtime.providerId, runtime]));
  // The run in progress, so a shutdown can stop it. One at a time by design.
  let stopActiveRun: ((reason: StopReason) => void) | null = null;

  /**
   * The recovery policy for interrupted runs. A run is "running" only while a
   * worker keeps its heartbeat fresh. If the heartbeat is stale, that worker
   * crashed or was killed mid-run. Such a run is marked failed, never re-run
   * automatically: Claude may already have done (and been charged for) the
   * work, and Solas can't verify a result it never received. The owner can
   * press Retry. Runs that were still pending are untouched and simply run.
   */
  async function recoverStaleRuns(): Promise<number> {
    const recovered = await db
      .update(runs)
      .set({
        status: "failed",
        errorCode: "worker_stopped",
        errorMessage: "The worker stopped while this reply was being written. No reply was saved; use Retry to ask again.",
        finishedAt: sql`now()`,
      })
      .where(
        and(
          eq(runs.status, "running"),
          sql`(${runs.heartbeatAt} is null or ${runs.heartbeatAt} < now() - make_interval(secs => ${limits.staleAfterMs / 1000}))`,
        ),
      )
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
      .set({ status: "running", startedAt: sql`now()`, heartbeatAt: sql`now()` })
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

    // The latest reply text the runtime has sent, kept for a failed or stopped run.
    const partial = { text: null as string | null };
    let outcome: Outcome;
    try {
      outcome = await perform(run, partial);
    } catch (error) {
      log("error", "run.crashed", { ...fields, error: truncate(error instanceof Error ? error.message : String(error)) });
      outcome = { status: "failed", code: "unexpected", message: "Something went wrong in the worker. Check its log." };
    }

    const saved = await finish(run, outcome, partial.text);
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

  async function perform(run: RunRow, partial: { text: string | null }): Promise<Outcome> {
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
    const stillRunning = and(eq(runs.id, run.id), eq(runs.status, "running"));
    const timer = setTimeout(() => stop("timeout"), limits.timeoutMs);
    // Once a second: prove this worker is alive, and learn whether the owner
    // pressed Stop. No row means the run was deleted (with its conversation)
    // or taken over by recovery: either way, stop working on it.
    const heartbeat = setInterval(() => {
      db.update(runs)
        .set({ heartbeatAt: sql`now()` })
        .where(stillRunning)
        .returning({ cancelRequestedAt: runs.cancelRequestedAt })
        .then(([row]) => {
          if (!row) stop("gone");
          else if (row.cancelRequestedAt) stop("cancelled");
        })
        .catch(() => {}); // A missed beat is retried a second later.
    }, limits.heartbeatMs);

    // Save the reply written so far, at most every progressWriteMs, so the
    // browser can show it while it's being written. Only the newest text matters.
    let unsaved: string | null = null;
    let saving = false;
    const progressWriter = setInterval(() => {
      if (unsaved === null || saving) return;
      const text = unsaved;
      unsaved = null;
      saving = true;
      db.update(runs)
        .set({ partialOutput: text })
        .where(stillRunning)
        .catch(() => {})
        .finally(() => (saving = false));
    }, limits.progressWriteMs);
    const onProgress = (text: string) => {
      unsaved = text;
      partial.text = text;
    };
    stopActiveRun = stop;

    try {
      const result = await runtime.run(
        { systemPrompt: agent.instructions, prompt, model: agent.modelId! },
        controller.signal,
        onProgress,
      );
      if (result.status === "completed") return result;
      if (result.status === "failed") {
        if (result.retryAt) log("info", "run.retry_after", { runId: run.id, retryAt: result.retryAt.toISOString() });
        return failed(result.code, result.message);
      }
      return stopped(stopReason ?? "cancelled");
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      clearInterval(progressWriter);
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
      return failed("worker_stopped", "The worker was stopped while this reply was being written. Use Retry to ask again.");
    }
    // "cancelled" (Stop) or "gone" (deleted / recovered): nothing more to save.
    return { status: "cancelled" };
  }

  /**
   * Records the outcome. Updates only a run that is still "running", so a
   * run that was deleted (with its agent or conversation) is left alone.
   */
  async function finish(run: RunRow, outcome: Outcome, partialText: string | null): Promise<boolean> {
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
            // The finished reply is now a message; the draft isn't needed.
            partialOutput: null,
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
          // Kept so the owner can see how far the reply got. It is never added
          // to the conversation, so it isn't used as context later.
          partialOutput: partialText,
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

  return { recoverStaleRuns, claimNextRun, runOnce, executeRun, abortActiveRun };
}

type StopReason = "timeout" | "cancelled" | "shutdown" | "gone";

function failed(code: string, message: string): Outcome {
  return { status: "failed", code, message };
}

export type RunExecutor = ReturnType<typeof createRunExecutor>;
