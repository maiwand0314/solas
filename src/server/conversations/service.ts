import "server-only";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { sendMessageSchema } from "@/lib/conversations/validation";
import { getDatabase, type Database } from "@/server/db/client";
import {
  agents,
  conversations,
  messages,
  runs,
  type AgentRow,
  type ConversationRow,
  type MessageRow,
  type RunRow,
} from "@/server/db/schema";
import { getAgentReadiness, providerRegistry, type ProviderRegistry } from "@/server/providers/registry";
import { ConversationServiceError, fromDatabaseError, validationError } from "./errors";

/** What the UI needs to know about a run: its state, never its internals. */
export type RunState = Pick<
  RunRow,
  "id" | "userMessageId" | "status" | "errorCode" | "errorMessage" | "createdAt" | "startedAt" | "finishedAt"
>;

export type ConversationSummary = Pick<ConversationRow, "id" | "title" | "createdAt" | "updatedAt"> & {
  agentId: string;
  agentName: string;
};

export type ConversationThread = {
  conversation: ConversationRow;
  agent: Pick<AgentRow, "id" | "name" | "role" | "enabled" | "providerId" | "modelId">;
  messages: MessageRow[];
  runs: RunState[];
};

const runStateColumns = {
  id: runs.id,
  userMessageId: runs.userMessageId,
  status: runs.status,
  errorCode: runs.errorCode,
  errorMessage: runs.errorMessage,
  createdAt: runs.createdAt,
  startedAt: runs.startedAt,
  finishedAt: runs.finishedAt,
};

const idSchema = z.uuid();
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
   */
  async function sendMessage(input: unknown): Promise<{ conversationId: string; runId: string }> {
    const { conversationId, agentId, content } = parse(sendMessageSchema, input);

    const existing = conversationId ? await getConversationRow(conversationId) : undefined;
    const agent = await getAgentRow(existing?.agentId ?? agentId!);
    assertAgentCanRun(agent);

    return query(() =>
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
          .values({ conversationId: id, role: "user", content })
          .returning({ id: messages.id });
        // Fails on the "one active run per conversation" index if a reply is
        // still pending: that's what stops duplicate submissions.
        const [run] = await tx
          .insert(runs)
          .values({ conversationId: id, agentId: agent.id, userMessageId: message.id })
          .returning({ id: runs.id });
        return { conversationId: id, runId: run.id };
      }),
    );
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
    const [agent, history, conversationRuns] = await Promise.all([
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
    ]);
    const { id: agentId, name, role, enabled, providerId, modelId } = agent;
    return {
      conversation,
      agent: { id: agentId, name, role, enabled, providerId, modelId },
      messages: history,
      runs: conversationRuns,
    };
  }

  async function getRun(id: unknown): Promise<RunState> {
    const runId = parse(idSchema, id);
    const [run] = await query(() => db.select(runStateColumns).from(runs).where(eq(runs.id, runId)).limit(1));
    if (!run) throw new ConversationServiceError("not_found", "This reply no longer exists.");
    return run;
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
    if (!conversation) {
      throw new ConversationServiceError("not_found", "This conversation doesn’t exist. It may have been deleted.");
    }
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

  return { sendMessage, list, get, getRun, cancelRun };
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
