import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, createDatabase } from "@/server/db/client";
import {
  agents,
  automationOccurrences,
  automations,
  conversations,
  messages,
  notifications,
  runs,
  tasks,
  toolCalls,
} from "@/server/db/schema";
import { insertAgent } from "@/server/runs/test-helpers";
import { createNotificationService, hrefOf } from "./service";
import { NOTIFICATION_LOOKBACK_HOURS, syncNotifications } from "./sync";

// The Notification Center (M6B) against the test database: the worker's sync
// (derives notifications from rows the engine already writes) and the web
// app's service (inbox and read state). Nothing here calls Claude.

const db = createDatabase(process.env.TEST_DATABASE_URL!);
const service = createNotificationService({ db });

beforeEach(async () => {
  await db.delete(notifications);
  await db.delete(automations);
  await db.delete(agents); // cascades to tasks, runs, tool calls
});

afterAll(async () => {
  await db.delete(notifications);
  await closeDatabase(db);
});

// Agent names are unique, and most tests need several agents.
let agentCounter = 0;
const newAgent = (overrides: Parameters<typeof insertAgent>[1] = {}) => insertAgent(db, { name: `Agent ${++agentCounter}`, ...overrides });

async function failedTask(overrides: Partial<typeof tasks.$inferInsert> = {}) {
  const agent = await newAgent();
  const [task] = await db
    .insert(tasks)
    .values({
      agentId: agent.id,
      title: "Write the weekly report",
      instructions: "Write it.",
      status: "failed",
      errorCode: "timeout",
      errorMessage: "The attempt didn’t finish within 10 minutes, so the run was stopped.",
      finishedAt: new Date(),
      ...overrides,
    })
    .returning();
  return { agent, task };
}

async function automationWithOccurrence(occurrence: Partial<typeof automationOccurrences.$inferInsert>) {
  const agent = await newAgent();
  const [automation] = await db
    .insert(automations)
    .values({ name: "Daily briefing", agentId: agent.id, instructions: "Brief me.", schedule: { kind: "daily", time: "08:00" } })
    .returning();
  const [row] = await db
    .insert(automationOccurrences)
    .values({
      automationId: automation.id,
      scheduledFor: new Date(),
      status: "missed",
      message: "Missed the run: the worker wasn’t running.",
      ...occurrence,
    } as typeof automationOccurrences.$inferInsert)
    .returning();
  return { agent, automation, occurrence: row };
}

async function approvalCall(status: "awaiting_approval" | "expired" | "rejected" | "approved", expiresInMs = 60_000) {
  const agent = await newAgent({ name: `Developer ${++agentCounter}` });
  const [task] = await db
    .insert(tasks)
    .values({ agentId: agent.id, title: "Deploy notes", instructions: "Do it.", status: "awaiting_approval" })
    .returning();
  const [run] = await db.insert(runs).values({ taskId: task.id, agentId: agent.id, attempt: 1 }).returning();
  const [call] = await db
    .insert(toolCalls)
    .values({
      runId: run.id,
      toolId: "write_file",
      // Not a credential, but proves the notification text never copies tool input.
      input: { path: "notes/plan.md", content: "sk-live-SECRET-VALUE" },
      inputSummary: "notes/plan.md",
      status,
      requiresApproval: true,
      approvalExpiresAt: new Date(Date.now() + expiresInMs),
      decidedAt: status === "rejected" || status === "approved" ? new Date() : null,
      finishedAt: status === "expired" ? new Date() : null,
    })
    .returning();
  return { agent, task, run, call };
}

const all = () => db.select().from(notifications);

describe("failed tasks", () => {
  it("creates one notification per failure, with a link to the task", async () => {
    const { task } = await failedTask();
    expect(await syncNotifications(db)).toEqual({ created: 1 });

    const [n] = await all();
    expect(n).toMatchObject({
      kind: "task_failed",
      title: "Task failed: Write the weekly report",
      taskId: task.id,
      readAt: null,
    });
    expect(n.body).toContain("didn’t finish within 10 minutes");
    expect(hrefOf(n)).toBe(`/tasks/${task.id}`);
    expect((await service.list())[0]).toMatchObject({ href: `/tasks/${task.id}`, approval: null });
  });

  it("does not repeat a notification for the same failure, however often the sync runs", async () => {
    await failedTask();
    await syncNotifications(db);
    expect(await syncNotifications(db)).toEqual({ created: 0 });
    expect(await all()).toHaveLength(1);
  });

  it("notifies again when a retried task fails again, but not for a task that is only retried", async () => {
    const { task } = await failedTask({ finishedAt: new Date(Date.now() - 3_600_000) });
    await syncNotifications(db);
    await db.update(tasks).set({ status: "queued", finishedAt: null }).where(eq(tasks.id, task.id));
    expect(await syncNotifications(db)).toEqual({ created: 0 });
    await db.update(tasks).set({ status: "failed", finishedAt: new Date() }).where(eq(tasks.id, task.id));
    expect(await syncNotifications(db)).toEqual({ created: 1 });
    expect(await all()).toHaveLength(2);
  });

  it("reports an interrupted task (a lost worker that wasn’t safe to repeat) as its own kind", async () => {
    await failedTask({ status: "interrupted", errorCode: "worker_stopped", errorMessage: "The worker stopped; not safe to repeat." });
    await syncNotifications(db);
    expect(await all()).toMatchObject([{ kind: "task_interrupted", title: "Task interrupted: Write the weekly report" }]);
  });

  it("ignores completed and cancelled tasks, and failures older than the lookback window", async () => {
    await failedTask({ status: "completed", errorCode: null, errorMessage: null });
    await failedTask({ status: "cancelled", errorCode: null, errorMessage: null });
    await failedTask({ finishedAt: new Date(Date.now() - (NOTIFICATION_LOOKBACK_HOURS + 1) * 3_600_000) });
    expect(await syncNotifications(db)).toEqual({ created: 0 });
  });

  it("keeps the notification, without a link, when its task is deleted", async () => {
    const { task } = await failedTask();
    await syncNotifications(db);
    await db.delete(tasks).where(eq(tasks.id, task.id));
    expect((await service.list())[0]).toMatchObject({ href: null, title: "Task failed: Write the weekly report" });
  });
});

describe("automations", () => {
  it("notifies about a missed run, linking to the automation", async () => {
    const { automation } = await automationWithOccurrence({ status: "missed", missedCount: 1 });
    await syncNotifications(db);
    const [n] = await all();
    expect(n).toMatchObject({ kind: "automation_missed", title: "Missed run: Daily briefing", automationId: automation.id });
    expect(hrefOf(n)).toBe(`/automations/${automation.id}`);
    expect(await syncNotifications(db)).toEqual({ created: 0 });
  });

  it("notifies when a run is skipped because nobody can work on it, or the automation was paused", async () => {
    const { automation } = await automationWithOccurrence({ status: "skipped", reason: "agent_unavailable", message: "Skipped: disabled." });
    await db.insert(automationOccurrences).values({
      automationId: automation.id,
      scheduledFor: new Date(Date.now() + 1_000),
      status: "skipped",
      reason: "paused_after_failures",
      message: "Paused: the last 2 runs failed in a row.",
    });
    await syncNotifications(db);
    expect((await all()).map((n) => n.kind).sort()).toEqual(["automation_paused", "automation_skipped"]);
  });

  it("stays quiet about safeguards that work as designed (overlap, usage and run limits)", async () => {
    const { automation } = await automationWithOccurrence({ status: "skipped", reason: "overlap", message: "Skipped: overlap." });
    let offset = 1_000;
    for (const reason of ["usage_limit", "concurrency_limit", "daily_limit", "automation_daily_limit"] as const) {
      await db
        .insert(automationOccurrences)
        .values({ automationId: automation.id, scheduledFor: new Date(Date.now() + (offset += 1_000)), status: "skipped", reason, message: "Skipped." });
    }
    expect(await syncNotifications(db)).toEqual({ created: 0 });
  });
});

describe("approvals", () => {
  it("announces a pending request, then shows its current state, never the tool input", async () => {
    const { task, call } = await approvalCall("awaiting_approval");
    await syncNotifications(db);
    const [n] = await all();
    expect(n).toMatchObject({ kind: "approval_requested", taskId: task.id, toolCallId: call.id });
    expect(JSON.stringify(n)).not.toContain("SECRET");
    expect(JSON.stringify(n)).not.toContain("notes/plan.md");

    expect((await service.list())[0]).toMatchObject({ href: `/tasks/${task.id}`, approval: { status: "awaiting_approval", open: true } });

    // The owner approves on the task page: the notification now shows it is no longer waiting.
    await db.update(toolCalls).set({ status: "approved", decidedAt: new Date() }).where(eq(toolCalls.id, call.id));
    expect((await service.list())[0].approval).toMatchObject({ status: "approved", open: false });
    expect(await syncNotifications(db)).toEqual({ created: 0 });
  });

  it("shows a request whose time ran out as expired, even before the worker has recorded it", async () => {
    const { call } = await approvalCall("awaiting_approval", -1_000);
    // Already past its deadline: not announced as something to act on…
    expect(await syncNotifications(db)).toEqual({ created: 0 });
    // …but if it had been announced earlier, the inbox says it expired.
    await db.insert(notifications).values({
      kind: "approval_requested",
      dedupeKey: `approval_requested:${call.id}`,
      title: "Approval needed: Developer",
      toolCallId: call.id,
      occurredAt: new Date(),
    });
    expect((await service.list())[0].approval).toMatchObject({ status: "expired", open: false });
  });

  it("notifies when a request expired or was rejected, once", async () => {
    await approvalCall("expired");
    await approvalCall("rejected");
    await syncNotifications(db);
    expect((await all()).map((n) => n.kind).sort()).toEqual(["approval_expired", "approval_rejected"]);
    expect((await all()).find((n) => n.kind === "approval_expired")?.body).toContain("did not run");
    expect(await syncNotifications(db)).toEqual({ created: 0 });
  });

  it("does not notify about approved requests", async () => {
    await approvalCall("approved");
    expect(await syncNotifications(db)).toEqual({ created: 0 });
  });

  it("links a conversation's approval to the conversation", async () => {
    const agent = await newAgent();
    const [conversation] = await db.insert(conversations).values({ agentId: agent.id, title: "Chat" }).returning();
    const [message] = await db.insert(messages).values({ conversationId: conversation.id, role: "user", content: "Hi" }).returning();
    const [run] = await db
      .insert(runs)
      .values({ conversationId: conversation.id, agentId: agent.id, userMessageId: message.id, attempt: 1 })
      .returning();
    await db.insert(toolCalls).values({
      runId: run.id,
      toolId: "write_file",
      input: {},
      inputSummary: "x",
      status: "awaiting_approval",
      requiresApproval: true,
      approvalExpiresAt: new Date(Date.now() + 60_000),
    });
    await syncNotifications(db);
    expect((await service.list())[0].href).toBe(`/conversations/${conversation.id}`);
  });
});

describe("persistence, restarts, and concurrency", () => {
  it("survives a worker restart: a new process and connection find them, and add nothing", async () => {
    await failedTask();
    await syncNotifications(db);
    const restarted = createDatabase(process.env.TEST_DATABASE_URL!);
    try {
      expect(await createNotificationService({ db: restarted }).unreadCount()).toBe(1);
      expect(await syncNotifications(restarted)).toEqual({ created: 0 });
    } finally {
      await closeDatabase(restarted);
    }
  });

  it("catches up on events that happened while no worker was running", async () => {
    await failedTask();
    await approvalCall("expired");
    // Nothing synced yet (the worker was down). The next sync finds both.
    expect(await syncNotifications(db)).toEqual({ created: 2 });
  });

  it("makes exactly one notification per event when several syncs run at once", async () => {
    await failedTask();
    await automationWithOccurrence({ status: "missed", missedCount: 1 });
    await approvalCall("expired");
    await Promise.all(Array.from({ length: 6 }, () => syncNotifications(db)));
    expect(await all()).toHaveLength(3);
    const keys = (await all()).map((n) => n.dedupeKey);
    expect(new Set(keys).size).toBe(3);
  });

  it("refuses a second row with the same dedupe key at the database level", async () => {
    await db.insert(notifications).values({ kind: "task_failed", dedupeKey: "k", title: "a", occurredAt: new Date() });
    await expect(
      db.insert(notifications).values({ kind: "task_failed", dedupeKey: "k", title: "b", occurredAt: new Date() }),
    ).rejects.toBeTruthy();
  });
});

describe("read state", () => {
  async function two() {
    await failedTask({ title: "First", finishedAt: new Date(Date.now() - 60_000) });
    await failedTask({ title: "Second" });
    await syncNotifications(db);
    return service.list();
  }

  it("lists newest first and counts unread", async () => {
    const list = await two();
    expect(list.map((n) => n.title)).toEqual(["Task failed: Second", "Task failed: First"]);
    expect(await service.unreadCount()).toBe(2);
  });

  it("marks one read and unread again, and keeps the first read time", async () => {
    const [first] = await two();
    await service.markRead(first.id);
    const readAt = (await service.list()).find((n) => n.id === first.id)!.readAt;
    expect(readAt).not.toBeNull();
    expect(await service.unreadCount()).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await service.markRead(first.id);
    expect((await service.list()).find((n) => n.id === first.id)!.readAt).toEqual(readAt);

    await service.markUnread(first.id);
    expect(await service.unreadCount()).toBe(2);
  });

  it("marks everything read, and a later event is unread again", async () => {
    await two();
    expect(await service.markAllRead()).toBe(2);
    expect(await service.unreadCount()).toBe(0);
    await failedTask({ title: "Third" });
    await syncNotifications(db);
    expect(await service.unreadCount()).toBe(1);
  });

  it("rejects an invalid id", async () => {
    await expect(service.markRead("nope")).rejects.toBeTruthy();
  });
});

// A sanity check that the migration's database-level constraint matches the code's list of kinds.
describe("schema", () => {
  it("only accepts known notification kinds", async () => {
    await expect(
      db.execute(sql`insert into notifications (kind, dedupe_key, title, occurred_at) values ('bogus', 'x', 't', now())`),
    ).rejects.toBeTruthy();
  });
});
