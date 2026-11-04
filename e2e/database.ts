import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { e2eDatabaseUrl } from "../playwright.config";
import * as schema from "../src/server/db/schema";

// Direct database access for browser tests: set up exactly the state a test
// needs, and check what the app saved. Replies are written here, as the
// worker would write them, so no AI provider is involved.

// Shared by every test file in the worker, so no file closes it: idle
// connections close themselves, and the worker process ends after the run.
const client = postgres(e2eDatabaseUrl(), { max: 2, idle_timeout: 1, onnotice: () => {} });
export const db = drizzle({ client, schema });
export const {
  agents,
  agentToolPermissions,
  agentDelegationTargets,
  conversations,
  messages,
  runs,
  toolCalls,
  tasks,
  taskEvents,
  taskDelegations,
  teams,
  teamMembers,
  automations,
  automationOccurrences,
} = schema;

export async function resetDatabase() {
  await db.delete(teams); // cascades to team membership
  await db.delete(agents); // cascades to conversations, messages, tasks, runs, and automations
}

/** An automation as the service would save it (the scheduler never runs in these tests). */
export async function createAutomation(agentId: string, overrides: Partial<typeof automations.$inferInsert> = {}) {
  const [automation] = await db
    .insert(automations)
    .values({
      name: "Daily AI Research Briefing",
      agentId,
      instructions: "Summarize the latest developments in AI and software engineering.",
      schedule: { kind: "daily", time: "08:00" },
      timeZone: "Europe/Oslo",
      nextRunAt: new Date(Date.now() + 60 * 60_000),
      ...overrides,
    })
    .returning();
  return automation;
}

/** One entry in an automation's history, optionally with the task it started. */
export async function addOccurrence(
  automationId: string,
  fields: Omit<typeof automationOccurrences.$inferInsert, "automationId">,
) {
  const [occurrence] = await db.insert(automationOccurrences).values({ automationId, ...fields }).returning();
  return occurrence;
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

/** Finishes a run the way the worker does: saves the reply and completes the run, in one transaction. */
export async function completeRun(runId: string, text: string) {
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
    await tx.insert(messages).values({ conversationId: run.conversationId!, role: "assistant", content: text, runId });
    await tx.update(runs).set({ status: "completed", partialOutput: null, finishedAt: new Date() }).where(eq(runs.id, runId));
  });
}

/** Moves a pending run to running with some text written, as the worker does while streaming. */
export async function streamInto(runId: string, text: string) {
  await db.update(runs).set({ status: "running", startedAt: new Date(), heartbeatAt: new Date(), partialOutput: text }).where(eq(runs.id, runId));
}

/** Enables tools for an agent, as Agent Builder would. */
export async function setTools(agentId: string, tools: { toolId: string; mode: "allow" | "ask" }[]) {
  await db.insert(agentToolPermissions).values(tools.map((tool) => ({ agentId, ...tool })));
}

/** Records a tool call on a run, the way the worker's invoker does. */
export async function createToolCall(runId: string, overrides: Partial<typeof toolCalls.$inferInsert> = {}) {
  const [call] = await db
    .insert(toolCalls)
    .values({
      runId,
      toolId: "read_workspace_file",
      input: { path: "notes/plan.md" },
      inputSummary: "notes/plan.md",
      status: "awaiting_approval",
      requiresApproval: true,
      approvalExpiresAt: new Date(Date.now() + 5 * 60_000),
      ...overrides,
    })
    .returning();
  return call;
}

export async function toolCallById(id: string) {
  const [call] = await db.select().from(toolCalls).where(eq(toolCalls.id, id));
  return call;
}

type SeedTask = Partial<typeof tasks.$inferInsert> & {
  /** The latest attempt's state; pending unless overridden. */
  run?: Partial<typeof runs.$inferInsert>;
  /** Timeline entries, oldest first. */
  events?: { type: schema.TaskEventType; message: string }[];
};

/** A task with one attempt, in whatever state a test needs, as the web app and worker would leave it. */
export async function createTask(agentId: string, { run: runFields, events = [], ...fields }: SeedTask = {}) {
  const [task] = await db
    .insert(tasks)
    .values({ agentId, title: "Research AI Agent Architectures", instructions: "Compare three kinds of AI systems.", ...fields })
    .returning();
  const [run] = await db.insert(runs).values({ taskId: task.id, agentId, attempt: 1, ...runFields }).returning();
  const timeline = [
    { type: "created" as const, message: "You created this task." },
    { type: "queued" as const, message: "Queued as attempt 1. It starts when the worker picks it up." },
    ...events,
  ];
  for (const event of timeline) await db.insert(taskEvents).values({ taskId: task.id, runId: run.id, ...event });
  return { task, run };
}

export async function taskById(id: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
  return task;
}

export async function runsOfTask(taskId: string) {
  return db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(runs.attempt);
}

export async function addTaskEvent(taskId: string, runId: string, type: schema.TaskEventType, message: string) {
  await db.insert(taskEvents).values({ taskId, runId, type, message });
}

/**
 * A delegation as the worker leaves it: a child task (with one attempt) for
 * `targetAgentId`, linked to the parent task.
 */
export async function createDelegation(
  parent: { id: string; agentId: string; title: string },
  targetAgentId: string,
  { child = {}, delegation = {} }: { child?: SeedTask; delegation?: Partial<typeof taskDelegations.$inferInsert> } = {},
) {
  const created = await createTask(targetAgentId, {
    title: "Turn the findings into a short report",
    instructions: "Turn these findings into a short report: A is fast, B is safe.",
    parentTaskId: parent.id,
    depth: 1,
    ...child,
  });
  const [link] = await db
    .insert(taskDelegations)
    .values({
      parentTaskId: parent.id,
      parentAgentId: parent.agentId,
      targetAgentId,
      childTaskId: created.task.id,
      taskDescription: "Turn these findings into a short report: A is fast, B is safe.",
      expectedOutput: "Three bullet points",
      requestHash: crypto.randomUUID(),
      ...delegation,
    })
    .returning();
  return { ...created, delegation: link };
}
