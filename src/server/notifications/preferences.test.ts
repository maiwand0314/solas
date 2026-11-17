import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createConversationService } from "@/server/conversations/service";
import { closeDatabase, createDatabase } from "@/server/db/client";
import { NOTIFICATION_KINDS, agents, notificationPreferences, notifications, runs, tasks, toolCalls } from "@/server/db/schema";
import { insertAgent, testProviders } from "@/server/runs/test-helpers";
import { createTaskService } from "@/server/tasks/service";
import { createNotificationPreferenceService } from "./preferences";
import { createNotificationService } from "./service";
import { syncNotifications } from "./sync";

// Notification preferences (M6C) against the test database: what is saved,
// what the sync then creates, and what muting must never change.

const db = createDatabase(process.env.TEST_DATABASE_URL!);
const preferences = createNotificationPreferenceService({ db });
const inbox = createNotificationService({ db });
const taskService = createTaskService({ db, providers: testProviders });
const conversations = createConversationService({ db, providers: testProviders });

// Event times come from the test's clock, preference times from the database's: keep them apart.
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(async () => {
  await db.delete(notifications);
  await db.delete(notificationPreferences);
  await db.delete(agents); // cascades to tasks, runs, tool calls
});

afterAll(async () => {
  await db.delete(notifications);
  await db.delete(notificationPreferences);
  await closeDatabase(db);
});

let agentCounter = 0;
const newAgent = () => insertAgent(db, { name: `Preferences agent ${++agentCounter}` });

async function failedTask(title = "Write the weekly report") {
  const agent = await newAgent();
  const [task] = await db
    .insert(tasks)
    .values({ agentId: agent.id, title, instructions: "Write it.", status: "failed", errorCode: "timeout", errorMessage: "Too slow.", finishedAt: new Date() })
    .returning();
  return task;
}

async function awaitingApproval() {
  const agent = await newAgent();
  const [task] = await db
    .insert(tasks)
    .values({ agentId: agent.id, title: "Deploy notes", instructions: "Do it.", status: "awaiting_approval" })
    .returning();
  const [run] = await db.insert(runs).values({ taskId: task.id, agentId: agent.id, attempt: 1, status: "running" }).returning();
  const [call] = await db
    .insert(toolCalls)
    .values({
      runId: run.id,
      toolId: "write_file",
      input: { path: "notes/plan.md", content: "plan" },
      inputSummary: "notes/plan.md",
      status: "awaiting_approval",
      requiresApproval: true,
      approvalExpiresAt: new Date(Date.now() + 60_000),
    })
    .returning();
  return { task, call };
}

const kinds = async () => (await db.select().from(notifications)).map((n) => n.kind).sort();

describe("saving preferences", () => {
  it("has every kind on by default, in a fixed order", async () => {
    expect(await preferences.list()).toEqual(NOTIFICATION_KINDS.map((kind) => ({ kind, enabled: true })));
  });

  it("saves a choice per kind and keeps it", async () => {
    await preferences.set({ kind: "task_failed", enabled: false });
    const list = await preferences.list();
    expect(list.find((p) => p.kind === "task_failed")).toEqual({ kind: "task_failed", enabled: false });
    expect(list.filter((p) => p.enabled)).toHaveLength(NOTIFICATION_KINDS.length - 1);
  });

  it("rejects an unknown kind and a value that isn't true or false", async () => {
    await expect(preferences.set({ kind: "email_everyone", enabled: false })).rejects.toThrow("Unknown notification type.");
    await expect(preferences.set({ kind: "task_failed", enabled: "no" })).rejects.toThrow("Choose on or off.");
    expect(await db.select().from(notificationPreferences)).toHaveLength(0);
  });

  it("saving the same value again doesn't move the line the sync looks behind", async () => {
    await preferences.set({ kind: "task_failed", enabled: false });
    await preferences.set({ kind: "task_failed", enabled: true });
    const [before] = await db.select().from(notificationPreferences);
    await tick();
    await preferences.set({ kind: "task_failed", enabled: true });
    const [after] = await db.select().from(notificationPreferences);
    expect(after.changedAt.getTime()).toBe(before.changedAt.getTime());
  });
});

describe("muting", () => {
  it("a muted kind creates no notifications; other kinds still do", async () => {
    await preferences.set({ kind: "task_failed", enabled: false });
    await tick();
    await failedTask();
    await awaitingApproval();
    expect(await syncNotifications(db)).toEqual({ created: 1 });
    expect(await kinds()).toEqual(["approval_requested"]);
  });

  it("keeps existing notifications of a muted kind, with their read state", async () => {
    await failedTask();
    await syncNotifications(db);
    const [existing] = await db.select().from(notifications);
    await inbox.markRead(existing.id);

    await preferences.set({ kind: "task_failed", enabled: false });
    await syncNotifications(db);
    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0].readAt).not.toBeNull();
  });

  it("turning a kind back on doesn't replay what happened while it was muted, and makes no duplicates", async () => {
    await preferences.set({ kind: "task_failed", enabled: false });
    await tick();
    await failedTask("Failed while muted");
    await syncNotifications(db);
    await tick();

    await preferences.set({ kind: "task_failed", enabled: true });
    expect(await syncNotifications(db)).toEqual({ created: 0 });

    await tick();
    await failedTask("Failed after turning it back on");
    expect(await syncNotifications(db)).toEqual({ created: 1 });
    expect(await syncNotifications(db)).toEqual({ created: 0 });
    const titles = (await db.select().from(notifications)).map((n) => n.title);
    expect(titles).toEqual(["Task failed: Failed after turning it back on"]);
  });

  it("a kind that was never muted still gets events from before any preference was saved", async () => {
    await failedTask();
    await tick();
    await preferences.set({ kind: "approval_expired", enabled: false });
    expect(await syncNotifications(db)).toEqual({ created: 1 });
  });
});

describe("approvals are unchanged by muting", () => {
  it("muting approval requests hides only the inbox entry: the request waits, shows on its task, and can be decided", async () => {
    await preferences.set({ kind: "approval_requested", enabled: false });
    await tick();
    const { task, call } = await awaitingApproval();
    await syncNotifications(db);
    expect(await db.select().from(notifications)).toHaveLength(0);

    // Nothing was approved or changed by the sync…
    const [stored] = await db.select().from(toolCalls).where(eq(toolCalls.id, call.id));
    expect(stored.status).toBe("awaiting_approval");
    // …the task page still shows the request…
    const detail = await taskService.get(task.id);
    expect(detail.toolCalls.map((c) => [c.id, c.status])).toEqual([[call.id, "awaiting_approval"]]);
    // …and the owner can still decide it, through the usual checks.
    await conversations.decideToolCall(call.id, "reject");
    const [decided] = await db.select().from(toolCalls).where(eq(toolCalls.id, call.id));
    expect(decided.status).toBe("rejected");
  });
});
