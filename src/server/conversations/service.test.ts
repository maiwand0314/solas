import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MESSAGE_MAX_LENGTH } from "@/lib/conversations/validation";
import { closeDatabase, createDatabase } from "@/server/db/client";
import { agents, messages, runs } from "@/server/db/schema";
import { insertAgent, testProviders } from "@/server/runs/test-helpers";
import { ConversationServiceError } from "./errors";
import { createConversationService, titleFrom } from "./service";

// Integration tests against the test database. Nothing here runs an agent:
// the web side only stores messages and queues runs.

const db = createDatabase(process.env.TEST_DATABASE_URL!);
const service = createConversationService({ db, providers: testProviders });
const MISSING_ID = "00000000-0000-4000-8000-000000000000";

async function expectError(promise: Promise<unknown>, code: ConversationServiceError["code"]) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ConversationServiceError);
  expect((error as ConversationServiceError).code).toBe(code);
  return error as ConversationServiceError;
}

beforeEach(async () => {
  await db.delete(agents); // cascades to conversations, messages, and runs
});

afterAll(async () => {
  await closeDatabase(db);
});

describe("sendMessage", () => {
  it("starts a conversation with the agent, stores the message, and queues a pending run", async () => {
    const agent = await insertAgent(db);
    const { conversationId, runId } = await service.sendMessage({ agentId: agent.id, content: "  What is ML?  " });

    const thread = await service.get(conversationId);
    expect(thread.conversation).toMatchObject({ agentId: agent.id, title: "What is ML?" });
    expect(thread.messages).toMatchObject([{ role: "user", content: "What is ML?" }]);
    expect(thread.runs).toMatchObject([{ id: runId, status: "pending" }]);
  });

  it("continues an existing conversation after the previous reply finished", async () => {
    const agent = await insertAgent(db);
    const first = await service.sendMessage({ agentId: agent.id, content: "One" });
    await db.update(runs).set({ status: "completed" }).where(eq(runs.id, first.runId));

    const second = await service.sendMessage({ conversationId: first.conversationId, content: "Two" });
    expect(second.conversationId).toBe(first.conversationId);
    expect((await service.get(first.conversationId)).messages.map((message) => message.content)).toEqual(["One", "Two"]);
  });

  it("refuses a second message while a reply is still pending (no duplicate runs)", async () => {
    const agent = await insertAgent(db);
    const { conversationId } = await service.sendMessage({ agentId: agent.id, content: "One" });

    await expectError(service.sendMessage({ conversationId, content: "One" }), "run_in_progress");
    const stored = await db.select().from(messages).where(eq(messages.conversationId, conversationId));
    expect(stored).toHaveLength(1); // the transaction rolled back the second message too
  });

  it("refuses disabled agents", async () => {
    const agent = await insertAgent(db, { enabled: false });
    const error = await expectError(service.sendMessage({ agentId: agent.id, content: "Hi" }), "agent_unavailable");
    expect(error.message).toContain("disabled");
  });

  it("refuses agents without a model, and models the registry doesn't offer", async () => {
    const noModel = await insertAgent(db, { name: "No model", providerId: null, modelId: null });
    await expectError(service.sendMessage({ agentId: noModel.id, content: "Hi" }), "agent_unavailable");

    // Written around the agent service, as if the registry changed after saving.
    const unknownModel = await insertAgent(db, { name: "Old model", modelId: "retired-model" });
    await expectError(service.sendMessage({ agentId: unknownModel.id, content: "Hi" }), "agent_unavailable");
    const unknownProvider = await insertAgent(db, { name: "Old provider", providerId: "gone", modelId: "x" });
    await expectError(service.sendMessage({ agentId: unknownProvider.id, content: "Hi" }), "agent_unavailable");
  });

  it("reports missing agents and conversations", async () => {
    await expectError(service.sendMessage({ agentId: MISSING_ID, content: "Hi" }), "agent_not_found");
    await expectError(service.sendMessage({ conversationId: MISSING_ID, content: "Hi" }), "not_found");
  });

  it.each([
    ["an empty message", { agentId: MISSING_ID, content: "   " }],
    ["a message over the limit", { agentId: MISSING_ID, content: "x".repeat(MESSAGE_MAX_LENGTH + 1) }],
    ["no target", { content: "Hi" }],
    ["a malformed client message id", { agentId: MISSING_ID, content: "Hi", clientMessageId: "abc" }],
    ["a malformed id", { agentId: "not-a-uuid", content: "Hi" }],
    ["unknown fields", { agentId: MISSING_ID, content: "Hi", role: "assistant" }],
  ])("rejects %s", async (_label, input) => {
    await expectError(service.sendMessage(input), "validation_failed");
    expect(await db.select().from(messages)).toHaveLength(0);
  });
});

describe("duplicate prevention", () => {
  it("returns the first result when the same message is sent again (a retried request)", async () => {
    const agent = await insertAgent(db);
    const clientMessageId = randomUUID();
    const first = await service.sendMessage({ agentId: agent.id, content: "Hi", clientMessageId });
    const again = await service.sendMessage({ agentId: agent.id, content: "Hi", clientMessageId });

    expect(again).toEqual(first);
    expect(await db.select().from(messages)).toHaveLength(1);
    expect(await db.select().from(runs)).toHaveLength(1);
  });

  it("stores one message when the same send arrives twice at the same moment", async () => {
    const agent = await insertAgent(db);
    const { conversationId, runId } = await service.sendMessage({ agentId: agent.id, content: "First" });
    await db.update(runs).set({ status: "completed" }).where(eq(runs.id, runId));
    const clientMessageId = randomUUID();

    const results = await Promise.all([
      service.sendMessage({ conversationId, content: "Second", clientMessageId }),
      service.sendMessage({ conversationId, content: "Second", clientMessageId }),
    ]);

    expect(results[0]).toEqual(results[1]);
    const stored = await db.select().from(messages).where(eq(messages.conversationId, conversationId));
    expect(stored.map((message) => message.content)).toEqual(["First", "Second"]);
  });

  it("refuses two different messages racing into one conversation", async () => {
    const agent = await insertAgent(db);
    const { conversationId, runId } = await service.sendMessage({ agentId: agent.id, content: "First" });
    await db.update(runs).set({ status: "completed" }).where(eq(runs.id, runId));

    const outcomes = await Promise.allSettled([
      service.sendMessage({ conversationId, content: "A" }),
      service.sendMessage({ conversationId, content: "B" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as ConversationServiceError).code).toBe("run_in_progress");
  });
});

describe("ownership", () => {
  it("refuses a conversation sent to as if it belonged to another agent", async () => {
    const owner = await insertAgent(db, { name: "Owner agent" });
    const other = await insertAgent(db, { name: "Other agent" });
    const { conversationId, runId } = await service.sendMessage({ agentId: owner.id, content: "Hi" });
    await db.update(runs).set({ status: "completed" }).where(eq(runs.id, runId));

    const error = await expectError(
      service.sendMessage({ conversationId, agentId: other.id, content: "Hi" }),
      "validation_failed",
    );
    expect(error.message).toContain("different agent");
    // The matching agent is accepted.
    await service.sendMessage({ conversationId, agentId: owner.id, content: "Again" });
  });

  it("keeps several conversations per agent, each with its own messages", async () => {
    const agent = await insertAgent(db);
    const a = await service.sendMessage({ agentId: agent.id, content: "Conversation A" });
    const b = await service.sendMessage({ agentId: agent.id, content: "Conversation B" });

    expect((await service.list()).map((conversation) => conversation.id)).toEqual([b.conversationId, a.conversationId]);
    expect((await service.get(a.conversationId)).messages.map((message) => message.content)).toEqual(["Conversation A"]);
    expect((await service.get(b.conversationId)).messages.map((message) => message.content)).toEqual(["Conversation B"]);
  });

  it("survives a restart: a new connection pool reads the same conversation", async () => {
    const agent = await insertAgent(db);
    const { conversationId } = await service.sendMessage({ agentId: agent.id, content: "Remember me" });

    const restarted = createDatabase(process.env.TEST_DATABASE_URL!);
    try {
      const thread = await createConversationService({ db: restarted, providers: testProviders }).get(conversationId);
      expect(thread.messages.map((message) => message.content)).toEqual(["Remember me"]);
    } finally {
      await closeDatabase(restarted);
    }
  });
});

describe("rename and delete", () => {
  it("renames a conversation without moving it in the list", async () => {
    const agent = await insertAgent(db);
    const { conversationId } = await service.sendMessage({ agentId: agent.id, content: "Hi" });
    const before = (await service.get(conversationId)).conversation;

    const renamed = await service.rename(conversationId, "  Database choices  ");
    expect(renamed.title).toBe("Database choices");
    expect(renamed.updatedAt).toEqual(before.updatedAt);
  });

  it("rejects empty and over-long titles, and unknown conversations", async () => {
    const agent = await insertAgent(db);
    const { conversationId } = await service.sendMessage({ agentId: agent.id, content: "Hi" });
    await expectError(service.rename(conversationId, "   "), "validation_failed");
    await expectError(service.rename(conversationId, "x".repeat(121)), "validation_failed");
    await expectError(service.rename(MISSING_ID, "Title"), "not_found");
  });

  it("deletes a conversation with its messages and runs, and nothing else", async () => {
    const agent = await insertAgent(db);
    const doomed = await service.sendMessage({ agentId: agent.id, content: "Delete me" });
    const kept = await service.sendMessage({ agentId: agent.id, content: "Keep me" });

    await service.remove(doomed.conversationId);
    await expectError(service.get(doomed.conversationId), "not_found");
    expect((await db.select().from(messages)).map((message) => message.content)).toEqual(["Keep me"]);
    expect((await db.select().from(runs)).map((run) => run.id)).toEqual([kept.runId]);
    expect((await db.select().from(agents)).length).toBe(1);
    await expectError(service.remove(doomed.conversationId), "not_found");
  });
});

describe("retryRun", () => {
  it("queues a new run for the latest message after a failure", async () => {
    const agent = await insertAgent(db);
    const { conversationId, runId } = await service.sendMessage({ agentId: agent.id, content: "Hi" });
    await db.update(runs).set({ status: "failed", errorCode: "usage_limit" }).where(eq(runs.id, runId));

    const retry = await service.retryRun(runId);
    expect(retry.conversationId).toBe(conversationId);
    expect(retry.runId).not.toBe(runId);
    const thread = await service.get(conversationId);
    expect(thread.messages).toHaveLength(1); // the message isn't duplicated
    expect(thread.runs.map((run) => run.status)).toEqual(["failed", "pending"]);
  });

  it("refuses to retry a run that is still active, already answered, or not the latest", async () => {
    const agent = await insertAgent(db);
    const { conversationId, runId } = await service.sendMessage({ agentId: agent.id, content: "One" });
    await expectError(service.retryRun(runId), "validation_failed"); // pending

    await db.update(runs).set({ status: "failed" }).where(eq(runs.id, runId));
    await service.sendMessage({ conversationId, content: "Two" });
    await expectError(service.retryRun(runId), "validation_failed"); // a newer message exists
  });

  it("refuses to retry when the agent has been disabled", async () => {
    const agent = await insertAgent(db);
    const { runId } = await service.sendMessage({ agentId: agent.id, content: "Hi" });
    await db.update(runs).set({ status: "failed" }).where(eq(runs.id, runId));
    await db.update(agents).set({ enabled: false }).where(eq(agents.id, agent.id));
    await expectError(service.retryRun(runId), "agent_unavailable");
  });
});

describe("cancelRun", () => {
  it("cancels a pending run at once", async () => {
    const agent = await insertAgent(db);
    const { runId } = await service.sendMessage({ agentId: agent.id, content: "Hi" });
    expect((await service.cancelRun(runId)).status).toBe("cancelled");
  });

  it("asks the worker to stop a running run, and leaves finished runs alone", async () => {
    const agent = await insertAgent(db);
    const { runId } = await service.sendMessage({ agentId: agent.id, content: "Hi" });
    await db.update(runs).set({ status: "running" }).where(eq(runs.id, runId));

    expect((await service.cancelRun(runId)).status).toBe("running");
    const [row] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(row.cancelRequestedAt).not.toBeNull();

    await db.update(runs).set({ status: "completed" }).where(eq(runs.id, runId));
    expect((await service.cancelRun(runId)).status).toBe("completed");
  });
});

describe("titleFrom", () => {
  it("uses the first line, shortened to fit", () => {
    expect(titleFrom("First line\nSecond line")).toBe("First line");
    expect(titleFrom("x".repeat(200))).toHaveLength(80);
  });
});
