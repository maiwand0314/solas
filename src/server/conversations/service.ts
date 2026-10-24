import "server-only";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { conversationTitleSchema, sendMessageSchema } from "@/lib/conversations/validation";
import { getDatabase, type Database } from "@/server/db/client";
import {
  agents,
  conversations,
  messages,
  runs,
  toolCalls,
  type AgentRow,
  type ConversationRow,
  type MessageRow,
  type RunRow,
  type ToolCallRow,
} from "@/server/db/schema";
import { getAgentReadiness, providerRegistry, type ProviderRegistry } from "@/server/providers/registry";
import { ConversationServiceError, fromDatabaseError, validationError } from "./errors";

/** What the UI needs to know about a run: its state, never its internals. */
export type RunState = Pick<
  RunRow,
  | "id"
  | "userMessageId"
  | "status"
  | "errorCode"
  | "errorMessage"
  | "partialOutput"
  | "createdAt"
  | "startedAt"
  | "finishedAt"
>;

export type SendResult = { conversationId: string; runId: string };

/** A tool call as the conversation shows it. */
export type ToolCallView = Pick<
  ToolCallRow,
  | "id"
  | "runId"
  | "toolId"
  | "input"
  | "inputSummary"
  | "status"
  | "requiresApproval"
  | "approvalExpiresAt"
  | "decidedAt"
  | "resultSummary"
  | "errorMessage"
  | "createdAt"
  | "finishedAt"
>;

/** A run's state plus its tool activity, as the live view polls it. */
export type RunSnapshot = RunState & { toolCalls: ToolCallView[] };

export type ConversationSummary = Pick<ConversationRow, "id" | "title" | "createdAt" | "updatedAt"> & {
  agentId: string;
  agentName: string;
};

export type ConversationThread = {
  conversation: ConversationRow;
  agent: Pick<AgentRow, "id" | "name" | "role" | "enabled" | "providerId" | "modelId">;
  messages: MessageRow[];
  runs: RunState[];
  toolCalls: ToolCallView[];
};

const runStateColumns = {
  id: runs.id,
  userMessageId: runs.userMessageId,
  status: runs.status,
  errorCode: runs.errorCode,
  errorMessage: runs.errorMessage,
  partialOutput: runs.partialOutput,
  createdAt: runs.createdAt,
  startedAt: runs.startedAt,
  finishedAt: runs.finishedAt,
};

const toolCallColumns = {
  id: toolCalls.id,
  runId: toolCalls.runId,
  toolId: toolCalls.toolId,
  input: toolCalls.input,
  inputSummary: toolCalls.inputSummary,
  status: toolCalls.status,
  requiresApproval: toolCalls.requiresApproval,
  approvalExpiresAt: toolCalls.approvalExpiresAt,
  decidedAt: toolCalls.decidedAt,
  resultSummary: toolCalls.resultSummary,
  errorMessage: toolCalls.errorMessage,
  createdAt: toolCalls.createdAt,
  finishedAt: toolCalls.finishedAt,
};

const idSchema = z.uuid();
const decisionSchema = z.enum(["approve", "reject"], { error: "Choose approve or reject." });
const TITLE_LENGTH = 80;

type Dependencies = {
  db: Database;
  providers: ProviderRegistry;
};

/**
 * Conversations from the web app's side: store the owner's message and queue
 * a run for the worker. Nothing here talks to Claude. The web process never
 * runs agents (see src/server/runs/executor.ts for the worker's side).
 */
export function createConversationService({ db, providers }: Dependencies) {
  /**
   * Saves the owner's message and queues a run, in one transaction. Checks
   * the agent first so the owner gets an immediate, clear error instead of a
   * run that fails in the worker a second later.
   *
   * Safe to repeat: with the same `clientMessageId`, a second call (say, the
   * browser retrying after a dropped connection) returns the first result.
   */
  async function sendMessage(input: unknown): Promise<SendResult> {
    const { conversationId, agentId, clientMessageId, content } = parse(sendMessageSchema, input);

    if (clientMessageId) {
      const alreadySent = await findSent(clientMessageId);
      if (alreadySent) return alreadySent;
    }

    const existing = conversationId ? await getConversationRow(conversationId) : undefined;
    if (existing && agentId && existing.agentId !== agentId) {
      throw new ConversationServiceError("validation_failed", "This conversation belongs to a different agent.");
    }
    const agent = await getAgentRow(existing?.agentId ?? agentId!);
    assertAgentCanRun(agent);

    try {
      return await query(() =>
        db.transaction(async (tx) => {
          let id = existing?.id;
          if (id) {
            await tx.update(conversations).set({ updatedAt: sql`now()` }).where(eq(conversations.id, id));
          } else {
            const [created] = await tx
              .insert(conversations)
              .values({ agentId: agent.id, title: titleFrom(content) })
              .returning({ id: conversations.id });
            id = created.id;
          }
          const [message] = await tx
            .insert(messages)
            .values({ conversationId: id, role: "user", content, clientMessageId })
            .returning({ id: messages.id });
          // Fails on the "one active run per conversation" index if a reply is
          // still pending: that's what stops two different messages racing.
          const [run] = await tx
            .insert(runs)
            .values({ conversationId: id, agentId: agent.id, userMessageId: message.id })
            .returning({ id: runs.id });
          return { conversationId: id, runId: run.id };
        }),
      );
    } catch (error) {
      // Two identical sends at the same moment: the loser's transaction rolled
      // back, and it reports the winner's result.
      if (error instanceof ConversationServiceError && error.code === "duplicate_message" && clientMessageId) {
        const winner = await findSent(clientMessageId);
        if (winner) return winner;
      }
      throw error;
    }
  }

  /** The conversation and latest run for a message the browser already sent. */
  async function findSent(clientMessageId: string): Promise<SendResult | null> {
    const [sent] = await query(() =>
      db
        .select({ conversationId: messages.conversationId, runId: runs.id })
        .from(messages)
        .innerJoin(runs, eq(runs.userMessageId, messages.id))
        .where(eq(messages.clientMessageId, clientMessageId))
        .orderBy(desc(runs.createdAt))
        .limit(1),
    );
    return sent ?? null;
  }

  /**
   * Asks again for the latest message after its reply failed or was stopped.
   * Creates a new run for the same message; the old run stays in the record.
   * Only the latest message qualifies, so a retry never answers out of order.
   */
  async function retryRun(id: unknown): Promise<SendResult> {
    const runId = parse(idSchema, id);
    const [run] = await query(() => db.select().from(runs).where(eq(runs.id, runId)).limit(1));
    if (!run) throw new ConversationServiceError("not_found", "This reply no longer exists.");
    if (run.status !== "failed" && run.status !== "cancelled") {
      throw new ConversationServiceError("validation_failed", "Only a failed or stopped reply can be retried.");
    }
    const [latest] = await query(() =>
      db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.conversationId, run.conversationId))
        .orderBy(desc(messages.createdAt))
        .limit(1),
    );
    if (latest?.id !== run.userMessageId) {
      throw new ConversationServiceError("validation_failed", "Only the latest message can be retried.");
    }
    assertAgentCanRun(await getAgentRow(run.agentId));

    return query(() =>
      db.transaction(async (tx) => {
        const [retry] = await tx
          .insert(runs)
          .values({ conversationId: run.conversationId, agentId: run.agentId, userMessageId: run.userMessageId })
          .returning({ id: runs.id });
        await tx.update(conversations).set({ updatedAt: sql`now()` }).where(eq(conversations.id, run.conversationId));
        return { conversationId: run.conversationId, runId: retry.id };
      }),
    );
  }

  async function rename(id: unknown, title: unknown): Promise<ConversationRow> {
    const conversationId = parse(idSchema, id);
    const newTitle = parse(conversationTitleSchema, title);
    const [renamed] = await query(() =>
      db
        .update(conversations)
        // Keep updatedAt: the list is ordered by activity, and a rename isn't activity.
        .set({ title: newTitle, updatedAt: sql`${conversations.updatedAt}` })
        .where(eq(conversations.id, conversationId))
        .returning(),
    );
    if (!renamed) throw notFoundError();
    return renamed;
  }

  /**
   * Deletes a conversation with its messages and runs. A reply still being
   * written is abandoned: the worker's next heartbeat finds no run and stops.
   */
  async function remove(id: unknown): Promise<void> {
    const conversationId = parse(idSchema, id);
    const deleted = await query(() =>
      db.delete(conversations).where(eq(conversations.id, conversationId)).returning({ id: conversations.id }),
    );
    if (deleted.length === 0) throw notFoundError();
  }

  async function list(): Promise<ConversationSummary[]> {
    return query(() =>
      db
        .select({
          id: conversations.id,
          title: conversations.title,
          createdAt: conversations.createdAt,
          updatedAt: conversations.updatedAt,
          agentId: agents.id,
          agentName: agents.name,
        })
        .from(conversations)
        .innerJoin(agents, eq(agents.id, conversations.agentId))
        .orderBy(desc(conversations.updatedAt)),
    );
  }

  async function get(id: unknown): Promise<ConversationThread> {
    const conversation = await getConversationRow(parse(idSchema, id));
    const [agent, history, conversationRuns, calls] = await Promise.all([
      getAgentRow(conversation.agentId),
      query(() =>
        db
          .select()
          .from(messages)
          .where(eq(messages.conversationId, conversation.id))
          .orderBy(asc(messages.createdAt)),
      ),
      query(() =>
        db
          .select(runStateColumns)
          .from(runs)
          .where(eq(runs.conversationId, conversation.id))
          .orderBy(asc(runs.createdAt)),
      ),
      query(() =>
        db
          .select(toolCallColumns)
          .from(toolCalls)
          .innerJoin(runs, eq(runs.id, toolCalls.runId))
          .where(eq(runs.conversationId, conversation.id))
          .orderBy(asc(toolCalls.createdAt)),
      ),
    ]);
    const { id: agentId, name, role, enabled, providerId, modelId } = agent;
    return {
      conversation,
      agent: { id: agentId, name, role, enabled, providerId, modelId },
      messages: history,
      runs: conversationRuns,
      toolCalls: calls,
    };
  }

  async function getRun(id: unknown): Promise<RunSnapshot> {
    const runId = parse(idSchema, id);
    const [run] = await query(() => db.select(runStateColumns).from(runs).where(eq(runs.id, runId)).limit(1));
    if (!run) throw new ConversationServiceError("not_found", "This reply no longer exists.");
    const calls = await query(() =>
      db.select(toolCallColumns).from(toolCalls).where(eq(toolCalls.runId, runId)).orderBy(asc(toolCalls.createdAt)),
    );
    return { ...run, toolCalls: calls };
  }

  /**
   * The owner's decision on a tool call waiting for approval. Only a call
   * that is still waiting and not yet expired (by the database clock) can
   * be decided; a decision applies to that one call and its exact input.
   */
  async function decideToolCall(id: unknown, decision: unknown): Promise<ToolCallView> {
    const callId = parse(idSchema, id);
    const choice = parse(decisionSchema, decision);
    const [decided] = await query(() =>
      db
        .update(toolCalls)
        .set({ status: choice === "approve" ? "approved" : "rejected", decidedAt: sql`now()` })
        .where(
          and(
            eq(toolCalls.id, callId),
            eq(toolCalls.status, "awaiting_approval"),
            sql`${toolCalls.approvalExpiresAt} > now()`,
          ),
        )
        .returning(toolCallColumns),
    );
    if (decided) return decided;

    const [current] = await query(() => db.select(toolCallColumns).from(toolCalls).where(eq(toolCalls.id, callId)));
    if (!current) throw new ConversationServiceError("not_found", "This request no longer exists.");
    throw new ConversationServiceError(
      "validation_failed",
      current.status === "awaiting_approval" || current.status === "expired"
        ? "This request has expired, so the action was not run."
        : "This request was already decided.",
    );
  }

  /**
   * Stops a run. A pending run is cancelled right away. A running one gets a
   * cancel request that the worker picks up within about a second; the run
   * stays "running" until the worker has actually stopped it.
   */
  async function cancelRun(id: unknown): Promise<RunState> {
    const runId = parse(idSchema, id);
    const [cancelled] = await query(() =>
      db
        .update(runs)
        .set({ status: "cancelled", finishedAt: sql`now()` })
        .where(and(eq(runs.id, runId), eq(runs.status, "pending")))
        .returning(runStateColumns),
    );
    if (cancelled) return cancelled;

    const [requested] = await query(() =>
      db
        .update(runs)
        .set({ cancelRequestedAt: sql`now()` })
        .where(and(eq(runs.id, runId), eq(runs.status, "running"), isNull(runs.cancelRequestedAt)))
        .returning(runStateColumns),
    );
    // Otherwise it already finished, or Stop was already pressed.
    return requested ?? getRun(runId);
  }

  async function getConversationRow(id: string): Promise<ConversationRow> {
    const [conversation] = await query(() =>
      db.select().from(conversations).where(eq(conversations.id, id)).limit(1),
    );
    if (!conversation) throw notFoundError();
    return conversation;
  }

  async function getAgentRow(id: string): Promise<AgentRow> {
    const [agent] = await query(() => db.select().from(agents).where(eq(agents.id, id)).limit(1));
    if (!agent) throw new ConversationServiceError("agent_not_found", "This agent doesn’t exist. It may have been deleted.");
    return agent;
  }

  function assertAgentCanRun(agent: AgentRow) {
    const readiness = getAgentReadiness(agent, providers);
    if (readiness.state === "disabled") {
      throw new ConversationServiceError("agent_unavailable", `“${agent.name}” is disabled. Enable it to chat.`);
    }
    if (readiness.state === "unconfigured") {
      throw new ConversationServiceError(
        "agent_unavailable",
        `“${agent.name}” can’t answer yet: ${readiness.reason} Edit the agent and choose a model.`,
      );
    }
  }

  return { sendMessage, retryRun, rename, remove, list, get, getRun, cancelRun, decideToolCall };
}

function notFoundError() {
  return new ConversationServiceError("not_found", "This conversation doesn’t exist. It may have been deleted.");
}

/** The first line of the first message, shortened: a title that needs no AI call. */
export function titleFrom(content: string): string {
  const firstLine = content.trim().split("\n")[0].trim();
  return firstLine.length > TITLE_LENGTH ? `${firstLine.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : firstLine;
}

export type ConversationService = ReturnType<typeof createConversationService>;

export function getConversationService(): ConversationService {
  return createConversationService({ db: getDatabase(), providers: providerRegistry });
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

async function query<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ConversationServiceError) throw error;
    throw fromDatabaseError(error);
  }
}
