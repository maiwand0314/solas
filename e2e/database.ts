import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { e2eDatabaseUrl } from "../playwright.config";
import * as schema from "../src/server/db/schema";

// Direct database access for browser tests: set up exactly the state a test
// needs, and check what the app saved. Replies are written here, as the
// worker would write them, so no AI provider is involved.

const client = postgres(e2eDatabaseUrl(), { max: 2, onnotice: () => {} });
export const db = drizzle({ client, schema });
export const { agents, conversations, messages, runs } = schema;

export async function resetDatabase() {
  await db.delete(agents); // cascades to conversations, messages, and runs
}

export async function closeDatabase() {
  await client.end({ timeout: 5 });
}

export async function createAgent(overrides: Partial<typeof agents.$inferInsert> = {}) {
  const [agent] = await db
    .insert(agents)
    .values({
      name: "Research Assistant",
      role: "research",
      instructions: "Research topics and write clear reports.",
      providerId: "claude-agent-sdk",
      modelId: "claude-opus-5-5",
      ...overrides,
    })
    .returning();
  return agent;
}

type SeedTurn = { user: string; assistant?: string; run?: Partial<typeof runs.$inferInsert> };

/**
 * A conversation with completed turns. A turn without `assistant` gets a run
 * in the state given by `run` (pending unless overridden).
 */
export async function createConversation(agentId: string, title: string, turns: SeedTurn[]) {
  const [conversation] = await db.insert(conversations).values({ agentId, title }).returning();
  for (const [index, turn] of turns.entries()) {
    // Spread out the timestamps so the order is unambiguous.
    const at = sql`now() - make_interval(mins => ${(turns.length - index) * 2})`;
    const [userMessage] = await db
      .insert(messages)
      .values({ conversationId: conversation.id, role: "user", content: turn.user, createdAt: at })
      .returning();
    const [run] = await db
      .insert(runs)
      .values({
        conversationId: conversation.id,
        agentId,
        userMessageId: userMessage.id,
        status: turn.assistant ? "completed" : "pending",
        createdAt: at,
        ...turn.run,
      })
      .returning();
    if (turn.assistant) {
      await db.insert(messages).values({
        conversationId: conversation.id,
        role: "assistant",
        content: turn.assistant,
        runId: run.id,
        createdAt: sql`now() - make_interval(mins => ${(turns.length - index) * 2 - 1})`,
      });
    }
  }
  return conversation;
}

export async function runsOf(conversationId: string) {
  return db.select().from(runs).where(eq(runs.conversationId, conversationId)).orderBy(runs.createdAt);
}

export async function messagesOf(conversationId: string) {
  return db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(messages.createdAt);
}
