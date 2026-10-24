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
    ["two targets", { agentId: MISSING_ID, conversationId: MISSING_ID, content: "Hi" }],
    ["a malformed id", { agentId: "not-a-uuid", content: "Hi" }],
    ["unknown fields", { agentId: MISSING_ID, content: "Hi", role: "assistant" }],
  ])("rejects %s", async (_label, input) => {
    await expectError(service.sendMessage(input), "validation_failed");
    expect(await db.select().from(messages)).toHaveLength(0);
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
