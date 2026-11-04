import "server-only";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { classifyDatabaseError } from "@/server/db/errors";
import { agents, conversations, messages, runs, toolCalls, type RunRow, type RunStatus } from "@/server/db/schema";
import { truncate, type Logger } from "@/server/logger";
import { getAgentReadiness, type ProviderRegistry } from "@/server/providers/registry";
import type { AgentRuntime, RunUsage } from "@/server/runtime/types";
import { stopOrphanedChildren } from "@/server/tasks/cancel";
import { delegate, loadContinuation } from "@/server/tasks/delegation";
import { createTaskRunHandlers } from "@/server/tasks/execution";
import type { ToolInvoker } from "@/server/tools/invoker";
import { DELEGATION_LIMITS, RUN_LIMITS } from "./config";
import { buildContinuationPrompt, buildPrompt, buildSystemPrompt, buildTaskPrompt } from "./prompt";

// The worker's side of a run: claim a pending run, load the agent from
// PostgreSQL, call the agent's provider through the AgentRuntime interface,
// and record the outcome. The same code runs every agent; nothing here knows
// any agent by name. A run answers a conversation message or is one attempt
// at a task; both share everything here except the prompt and where the
// result is saved (task specifics live in src/server/tasks/execution.ts).

type Outcome =
  | { status: "completed"; text: string; usage: RunUsage }
  | { status: "failed"; code: string; message: string }
  | { status: "cancelled" };

export type ExecutorLimits = {
  timeoutMs: number;
  taskTimeoutMs: number;
  retryBackoffMs: number;
  /** Automatic retries a delegated (child) task starts with. */
  taskAutoRetries: number;
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
  /** Turns an agent's permissions into runnable tools. Without it, no agent gets tools. */
  tools?: ToolInvoker;
  /**
   * Whether a tool is known to change nothing (used by the task retry
   * policy). Defaults to "no tool is": an attempt that used any tool is then
   * never repeated automatically. Fail closed.
   */
  isReadOnlyTool?: (toolId: string) => boolean;
  /** Recorded on each run this executor claims, so a run's owner is known. */
  workerId?: string;
  limits?: ExecutorLimits;
  delegationLimits?: typeof DELEGATION_LIMITS;
};

export function createRunExecutor({
  db,
  providers,
  runtimes,
  log,
  tools,
  isReadOnlyTool = () => false,
  workerId = `worker-${process.pid}`,
  limits = RUN_LIMITS,
  delegationLimits = DELEGATION_LIMITS,
}: Dependencies) {
  const runtimeFor = new Map(runtimes.map((runtime) => [runtime.providerId, runtime]));
  const tasks = createTaskRunHandlers({ log, limits, isReadOnlyTool });
  // How to stop each run in progress, so a shutdown can stop them all.
  const stopFor = new Map<string, (reason: StopReason) => void>();
  // Runs this executor is working on right now.
  const executing = new Set<string>();
  // Set on shutdown, so a run claimed in that same moment stops as soon as it starts.
  let shuttingDown = false;

  /**
   * The recovery policy for interrupted runs. A run is "running" only while a
   * worker keeps its heartbeat fresh. If the heartbeat is stale, that worker
   * crashed or was killed mid-run, and the run is marked failed.
   *
   * - A conversation reply is never re-run automatically: Claude may already
   *   have done (and been charged for) the work, and Solas can't verify a
   *   result it never received. The owner can press Retry.
   * - A task attempt goes through the task retry policy: queued again if
   *   repeating it is safe and a retry is left, otherwise "interrupted".
   *
   * An approval request the lost attempt was waiting on is withdrawn, so it
   * can never be approved and run later. Pending runs are untouched and simply run.
   */
  async function recoverStaleRuns(): Promise<number> {
    const stale = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.status, "running"),
          sql`(${runs.heartbeatAt} is null or ${runs.heartbeatAt} < now() - make_interval(secs => ${limits.staleAfterMs / 1000}))`,
        ),
      );
    let recovered = 0;
    for (const { id } of stale) {
      const done = await db.transaction(async (tx) => {
        const [run] = await tx
          .update(runs)
          .set({
            status: "failed",
            errorCode: "worker_stopped",
            errorMessage: "The worker stopped while this reply was being written. No reply was saved; use Retry to ask again.",
            finishedAt: sql`now()`,
          })
          // Checked again: the run may have recovered its heartbeat or finished since the select.
          .where(
            and(
              eq(runs.id, id),
              eq(runs.status, "running"),
              sql`(${runs.heartbeatAt} is null or ${runs.heartbeatAt} < now() - make_interval(secs => ${limits.staleAfterMs / 1000}))`,
            ),
          )
          .returning();
        if (!run) return false;
        if (run.taskId) {
          await tasks.onAttemptEnded(tx, run, {
            status: "failed",
            code: "worker_stopped",
            message: "The worker stopped during this attempt.",
          });
        }
        await tx
          .update(toolCalls)
          .set({ status: "cancelled", errorMessage: "The worker stopped before a decision.", finishedAt: sql`now()` })
          .where(and(eq(toolCalls.runId, run.id), eq(toolCalls.status, "awaiting_approval")));
        return true;
      });
      if (done) recovered++;
    }
    // Children whose parent stopped, left running by a crash between the two steps.
    const orphans = await stopOrphanedChildren(db, log);
    if (orphans > 0) log("warn", "worker.stopped_orphaned_children", { count: orphans });
    return recovered;
  }

  /**
   * Takes the oldest pending run that is due and marks it running,
   * atomically. SKIP LOCKED means a second worker would take a different run
   * instead of waiting, so the same run can never be executed twice. For a
   * task, the task moves to running in the same transaction.
   *
   * The subquery is compared with `=`, not `IN`, on purpose. With `IN`,
   * PostgreSQL may plan a semi-join that re-runs the subquery for every row,
   * so "LIMIT 1" no longer holds and one claim marks several runs running.
   * A scalar subquery runs exactly once. (A claim made at the very same
   * moment as another can still come back empty; the next poll picks up
   * whatever it skipped.)
   */
  async function claimNextRun(): Promise<RunRow | null> {
    return db.transaction(async (tx) => {
      const oldestDue = tx
        .select({ id: runs.id })
        .from(runs)
        // A scheduled retry waits for its time (by the database clock).
        .where(and(eq(runs.status, "pending"), or(isNull(runs.notBefore), lte(runs.notBefore, sql`now()`))))
        .orderBy(asc(runs.createdAt))
        .limit(1)
        .for("update", { skipLocked: true });
      const [run] = await tx
        .update(runs)
        .set({ status: "running", workerId, startedAt: sql`now()`, heartbeatAt: sql`now()` })
        .where(and(sql`${runs.id} = (${oldestDue})`, eq(runs.status, "pending")))
        .returning();
      if (!run) return null;
      if (run.taskId && !(await tasks.onClaimed(tx, run))) {
        // The task can't start (cancelled at this very moment): neither can its run.
        await tx.update(runs).set({ status: "cancelled", finishedAt: sql`now()` }).where(eq(runs.id, run.id));
        log("warn", "run.claim_refused", { runId: run.id, taskId: run.taskId });
        return null;
      }
      return run;
    });
  }

  /** Claims and executes one run. Returns false when there was nothing to do. */
  async function runOnce(): Promise<boolean> {
    const run = await claimNextRun();
    if (!run) return false;
    await executeRun(run);
    return true;
  }

  /**
   * Executes a claimed run once. A run handed over a second time (already
   * executing here, or no longer "running" in the database) is skipped
   * without calling the provider: one message, one execution. Between
   * processes, claimNextRun already guarantees a single owner.
   */
  async function executeRun(run: RunRow): Promise<RunStatus | "skipped"> {
    const fields = {
      runId: run.id,
      agentId: run.agentId,
      conversationId: run.conversationId ?? undefined,
      taskId: run.taskId ?? undefined,
    };
    // Mark it before awaiting anything, so a second call in the same tick sees it.
    if (executing.has(run.id)) return skipped(fields);
    executing.add(run.id);
    try {
      if (!(await isStillRunning(run.id))) return skipped(fields);
      return await execute(run, fields);
    } finally {
      executing.delete(run.id);
    }
  }

  function skipped(fields: Record<string, string | undefined>): "skipped" {
    log("warn", "run.skipped_duplicate", fields);
    return "skipped";
  }

  async function isStillRunning(runId: string): Promise<boolean> {
    const [row] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).limit(1);
    return row?.status === "running";
  }

  async function execute(run: RunRow, fields: Record<string, string | undefined>): Promise<RunStatus> {
    const startedAt = Date.now();
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
    // A parent that stopped takes its delegated children with it (their own transactions).
    if (run.taskId && saved) await stopOrphanedChildren(db, log, run.taskId).catch(() => 0);
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
    // Cancel pressed between the claim and now: don't start the provider at all.
    const [current] = await db
      .select({ cancelRequestedAt: runs.cancelRequestedAt })
      .from(runs)
      .where(eq(runs.id, run.id))
      .limit(1);
    if (current?.cancelRequestedAt) return { status: "cancelled" };

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

    const prepared = await promptFor(run);
    if (prepared === null) return { status: "cancelled" }; // the task was deleted
    const { prompt, canDelegate } = prepared;
    await db.update(runs).set({ modelId: agent.modelId }).where(eq(runs.id, run.id));

    const controller = new AbortController();
    let stopReason: StopReason | null = null;
    const stop = (reason: StopReason) => {
      stopReason ??= reason;
      controller.abort();
    };
    const stillRunning = and(eq(runs.id, run.id), eq(runs.status, "running"));
    // The run's clock, paused while a tool call waits for the owner's approval.
    const deadline = createDeadline(timeoutFor(run), () => stop("timeout"));
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
    stopFor.set(run.id, stop);
    if (shuttingDown) stop("shutdown");

    try {
      // The agent's permitted tools, read now: a change in Agent Builder applies from this run on.
      const runTools =
        (await tools?.toolsForRun({
          runId: run.id,
          agentId: agent.id,
          signal: controller.signal,
          onApprovalWait: (waiting) => (waiting ? deadline.pause() : deadline.resume()),
          // A task records every tool step on its timeline.
          onEvent: run.taskId ? (event) => tasks.onToolEvent(db, run, event) : undefined,
          // Only a task's own work run, at a depth that still allows it, may delegate (M5A).
          delegate: canDelegate
            ? (request) =>
                delegate(db, { run, request, providers, limits: delegationLimits, autoRetries: limits.taskAutoRetries })
            : undefined,
        })) ?? [];
      const toolNames = runTools.map((tool) => tool.name);
      if (run.taskId) {
        await tasks.onStarted(db, run, { agentName: agent.name, model: agent.modelId!, toolCount: runTools.length });
      }
      const result = await runtime.run(
        {
          systemPrompt: buildSystemPrompt(agent.instructions, toolNames, run.taskId ? "task" : "conversation"),
          prompt,
          model: agent.modelId!,
          tools: runTools,
        },
        controller.signal,
        onProgress,
      );
      // Stopped (Cancel, timeout, shutdown): whatever the runtime returned
      // after that point isn't accepted as the result.
      if (controller.signal.aborted) return stopped(run, stopReason ?? "cancelled");
      if (result.status === "completed") return result;
      if (result.status === "failed") {
        if (result.retryAt) log("info", "run.retry_after", { runId: run.id, retryAt: result.retryAt.toISOString() });
        return failed(result.code, result.message);
      }
      return stopped(run, stopReason ?? "cancelled");
    } finally {
      deadline.clear();
      clearInterval(heartbeat);
      clearInterval(progressWriter);
      stopFor.delete(run.id);
    }
  }

  function timeoutFor(run: RunRow): number {
    return run.taskId ? limits.taskTimeoutMs : limits.timeoutMs;
  }

  /**
   * The prompt: the task's own words (or, for a follow-up after a delegation,
   * the task plus the delegated result), or the conversation so far plus the
   * new message. Null if the task is gone.
   */
  async function promptFor(run: RunRow): Promise<{ prompt: string; canDelegate: boolean } | null> {
    if (run.taskId) {
      const task = await tasks.loadTask(db, run.taskId);
      if (!task) return null;
      if (run.purpose === "continue") {
        const delegations = await loadContinuation(db, run.taskId);
        return { prompt: buildContinuationPrompt(task.title, task.instructions, delegations), canDelegate: false };
      }
      return { prompt: buildTaskPrompt(task.title, task.instructions), canDelegate: task.depth < delegationLimits.maxDepth };
    }
    const history = await db
      .select({ id: messages.id, role: messages.role, content: messages.content })
      .from(messages)
      .where(eq(messages.conversationId, run.conversationId!))
      .orderBy(asc(messages.createdAt));
    const index = history.findIndex((message) => message.id === run.userMessageId);
    if (index === -1) throw new Error("The run's message is missing.");
    return { prompt: buildPrompt(history.slice(0, index), history[index].content, limits), canDelegate: false };
  }

  function stopped(run: RunRow, reason: StopReason): Outcome {
    if (reason === "timeout") {
      const minutes = Math.round(timeoutFor(run) / 60_000);
      const what = run.taskId ? "The attempt didn’t finish" : "No reply";
      return failed("timeout", `${what} within ${minutes} ${minutes === 1 ? "minute" : "minutes"}, so the run was stopped.`);
    }
    if (reason === "shutdown") {
      return failed(
        "worker_stopped",
        run.taskId
          ? "The worker was stopped during this attempt."
          : "The worker was stopped while this reply was being written. Use Retry to ask again.",
      );
    }
    // "cancelled" (Stop) or "gone" (deleted / recovered): nothing more to save.
    return { status: "cancelled" };
  }

  /**
   * Records the outcome. Updates only a run that is still "running", so a
   * run that was deleted (with its agent or conversation) is left alone.
   */
  async function finish(run: RunRow, outcome: Outcome, partialText: string | null): Promise<boolean> {
    try {
      return await saveOutcome(run, outcome, partialText);
    } catch (error) {
      // The database refused a second reply for this run: it is already saved.
      if (classifyDatabaseError(error).kind === "unique_violation") {
        log("warn", "run.reply_already_saved", { runId: run.id });
        return false;
      }
      throw error;
    }
  }

  async function saveOutcome(run: RunRow, outcome: Outcome, partialText: string | null): Promise<boolean> {
    return db.transaction(async (tx) => {
      const stillRunning = and(eq(runs.id, run.id), eq(runs.status, "running"));
      const [updated] = await tx
        .update(runs)
        .set(
          outcome.status === "completed"
            ? {
                status: "completed",
                finishedAt: sql`now()`,
                inputTokens: outcome.usage.inputTokens,
                outputTokens: outcome.usage.outputTokens,
                // The finished text is now a message or the task's result; the draft isn't needed.
                partialOutput: null,
              }
            : {
                status: outcome.status,
                errorCode: outcome.status === "failed" ? outcome.code : null,
                errorMessage: outcome.status === "failed" ? outcome.message : null,
                // Kept so the owner can see how far it got. It is never added
                // to a conversation or saved as a result.
                partialOutput: partialText,
                finishedAt: sql`now()`,
              },
        )
        .where(stillRunning)
        .returning();
      if (!updated) return false;

      if (run.taskId) {
        await tasks.onAttemptEnded(tx, updated, outcome);
        return true;
      }
      if (outcome.status === "completed") {
        await tx
          .insert(messages)
          .values({ conversationId: run.conversationId!, role: "assistant", content: outcome.text, runId: run.id });
        await tx.update(conversations).set({ updatedAt: sql`now()` }).where(eq(conversations.id, run.conversationId!));
      }
      return true;
    });
  }

  /** Stops every run in progress (used when the worker shuts down). */
  function abortActiveRuns() {
    shuttingDown = true;
    for (const stop of stopFor.values()) stop("shutdown");
  }

  return { recoverStaleRuns, claimNextRun, runOnce, executeRun, abortActiveRuns };
}

type StopReason = "timeout" | "cancelled" | "shutdown" | "gone";

/** A timeout that can pause (while the owner decides on an approval) and resume. */
function createDeadline(ms: number, onExpire: () => void) {
  let remaining = ms;
  let since = Date.now();
  let paused = 0;
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(onExpire, ms);
  return {
    pause() {
      if (paused++ > 0) return;
      clearTimeout(timer);
      remaining -= Date.now() - since;
    },
    resume() {
      if (--paused > 0) return;
      since = Date.now();
      timer = setTimeout(onExpire, Math.max(0, remaining));
    },
    clear() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

function failed(code: string, message: string): Outcome {
  return { status: "failed", code, message };
}

export type RunExecutor = ReturnType<typeof createRunExecutor>;
