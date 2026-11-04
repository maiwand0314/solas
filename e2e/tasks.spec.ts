import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  addTaskEvent,
  createAgent,
  createTask,
  createToolCall,
  db,
  resetDatabase,
  runs,
  runsOfTask,
  taskById,
  tasks,
  toolCallById,
} from "./database";

// Tasks in a real browser. The worker isn't running here: its writes (claim,
// progress, result) are made directly in the database, exactly as the worker
// makes them, so these tests check what the owner sees and what the web app
// saves. The worker side is covered by the Vitest suites.

test.beforeEach(async () => {
  await resetDatabase();
});

const now = () => new Date();

/** Moves a task's attempt to running, as the worker's claim does. */
async function workerClaims(taskId: string, runId: string) {
  await db.update(runs).set({ status: "running", startedAt: now(), heartbeatAt: now(), workerId: "w" }).where(eq(runs.id, runId));
  await db.update(tasks).set({ status: "running", startedAt: now() }).where(eq(tasks.id, taskId));
  await addTaskEvent(taskId, runId, "claimed", "The worker picked up attempt 1.");
  await addTaskEvent(taskId, runId, "started", "Research Assistant started working (claude-opus-5-5, without tools).");
}

/** Saves a result and completes the task, as the worker does in one transaction. */
async function workerCompletes(taskId: string, runId: string, result: string) {
  await db.transaction(async (tx) => {
    await tx.update(runs).set({ status: "completed", finishedAt: now(), partialOutput: null, inputTokens: 1200, outputTokens: 800 }).where(eq(runs.id, runId));
    await tx.update(tasks).set({ status: "completed", result, finishedAt: now() }).where(eq(tasks.id, taskId));
  });
  await addTaskEvent(taskId, runId, "completed", "Completed. The result is saved.");
}

/** The page's own header (title, status badge, actions), not the app's top bar. */
const statusBadge = (page: Page) => page.getByRole("main").locator("header").first();
const agentField = (page: Page) => page.locator('select[name="agentId"]');

test("creates a task from the form, once, and opens it", async ({ page }) => {
  const agent = await createAgent();
  await createAgent({ name: "Switched off", enabled: false });

  await page.goto("/tasks");
  await expect(page.getByText("No tasks yet")).toBeVisible();
  await page.getByRole("link", { name: "New task" }).first().click();

  // Only agents that can run now are offered.
  const agentSelect = agentField(page);
  await expect(agentSelect.locator("option")).toHaveText(["Choose an agent", "Research Assistant — research"]);
  await expect(page.getByText("One agent isn’t listed because it is disabled or has no model.")).toBeVisible();
  await agentSelect.selectOption(agent.id);
  await expect(page.getByText("No tools: it can only write a reply.")).toBeVisible();
  await page.getByLabel("Title").fill("Research AI Agent Architectures");
  await page
    .getByLabel("Instructions")
    .fill("Explain the difference between a traditional chatbot, a tool-using AI agent, and a multi-agent system.");

  // A double submit creates one task.
  const submit = page.getByRole("button", { name: "Create task" });
  await submit.dblclick();
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: "Research AI Agent Architectures" })).toBeVisible();
  await expect(statusBadge(page)).toContainText("Queued");
  await expect(page.getByText("Waiting for the worker to pick it up.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Task events" })).toContainText("You created this task for Research Assistant.");

  const saved = await db.select().from(tasks);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ status: "queued", agentId: agent.id });
  expect(await runsOfTask(saved[0].id)).toMatchObject([{ status: "pending", attempt: 1 }]);
});

test("shows validation errors next to the fields and saves nothing", async ({ page }) => {
  await createAgent();
  await createAgent({ name: "Writer" });
  await page.goto("/tasks/new");
  await page.getByRole("button", { name: "Create task" }).click();

  await expect(page.getByText("Choose an agent.")).toBeVisible();
  await expect(page.getByText("Give the task a title.")).toBeVisible();
  await expect(page.getByText("Describe what the agent should do.")).toBeVisible();
  await expect(agentField(page)).toBeFocused();
  await expect(page.getByLabel("Title")).toHaveAttribute("aria-invalid", "true");
  expect(await db.select().from(tasks)).toHaveLength(0);
});

test("explains when no agent can take tasks", async ({ page }) => {
  await createAgent({ enabled: false });
  await page.goto("/tasks/new");
  await expect(page.getByText("No agent can take tasks yet")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open agents" })).toBeVisible();
});

test("follows the worker's real progress without a reload, then shows the saved result", async ({ page }) => {
  const agent = await createAgent();
  const { task, run } = await createTask(agent.id);
  await page.goto(`/tasks/${task.id}`);
  await expect(statusBadge(page)).toContainText("Queued");

  await workerClaims(task.id, run.id);
  await expect(statusBadge(page)).toContainText("Running");
  await expect(page.getByText("Research Assistant is working · attempt 1")).toBeVisible();
  await expect(page.getByRole("list", { name: "Task events" })).toContainText("The worker picked up attempt 1.");

  await db.update(runs).set({ partialOutput: "A **chatbot** answers" }).where(eq(runs.id, run.id));
  await expect(page.getByRole("heading", { name: "Written so far" })).toBeVisible();

  await workerCompletes(task.id, run.id, "## Comparison\n\nA **chatbot** answers; an *agent* acts.");
  await expect(statusBadge(page)).toContainText("Completed");
  await expect(page.getByRole("heading", { name: "Written so far" })).toBeHidden();
  const result = page.locator("section").filter({ has: page.getByRole("heading", { name: "Result", exact: true }) });
  await expect(result.getByRole("heading", { name: "Comparison" })).toBeVisible();
  await expect(result.locator("strong")).toHaveText("chatbot");
  await expect(page.getByText("1,200 in · 800 out tokens")).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Cancel|Retry)/ })).toHaveCount(0);
});

test("closing the browser changes nothing: the result is there on the next visit", async ({ browser }) => {
  const agent = await createAgent();
  const { task, run } = await createTask(agent.id);
  const first = await browser.newPage();
  await first.goto(`/tasks/${task.id}`);
  await workerClaims(task.id, run.id);
  await expect(statusBadge(first)).toContainText("Running");
  await first.close();

  // While no browser is open, the worker finishes.
  await workerCompletes(task.id, run.id, "Finished while you were away.");

  const later = await browser.newPage();
  await later.goto("/tasks");
  await expect(later.getByRole("link", { name: "Research AI Agent Architectures" })).toBeVisible();
  await later.getByRole("link", { name: "Research AI Agent Architectures" }).click();
  await expect(later.getByText("Finished while you were away.")).toBeVisible();
  await later.close();
});

test("cancels a queued task at once", async ({ page }) => {
  const agent = await createAgent();
  const { task, run } = await createTask(agent.id);
  await page.goto(`/tasks/${task.id}`);
  await page.getByRole("button", { name: `Cancel ${task.title}` }).click();

  await expect(statusBadge(page)).toContainText("Cancelled");
  expect((await taskById(task.id)).status).toBe("cancelled");
  expect((await runsOfTask(task.id))[0]).toMatchObject({ id: run.id, status: "cancelled" });
});

test("cancelling a running task asks the worker, shows 'Cancelling…', then the confirmed state", async ({ page }) => {
  const agent = await createAgent();
  const { task, run } = await createTask(agent.id);
  await workerClaims(task.id, run.id);
  await page.goto(`/tasks/${task.id}`);
  await page.getByRole("button", { name: `Cancel ${task.title}` }).click();

  await expect(statusBadge(page)).toContainText("Cancelling…");
  await expect(page.getByText("Waiting for the worker to stop the attempt · attempt 1.")).toBeVisible();
  const [saved] = await runsOfTask(task.id);
  expect(saved.status).toBe("running"); // truthfully still running…
  expect(saved.cancelRequestedAt).not.toBeNull(); // …with the request the worker acts on

  // The worker stops the attempt and records it.
  await db.update(runs).set({ status: "cancelled", finishedAt: now() }).where(eq(runs.id, run.id));
  await db.update(tasks).set({ status: "cancelled", finishedAt: now() }).where(eq(tasks.id, task.id));
  await expect(statusBadge(page)).toContainText("Cancelled");
});

test("retries a failed task as a new attempt", async ({ page }) => {
  const agent = await createAgent();
  const { task } = await createTask(agent.id, {
    status: "failed",
    errorCode: "usage_limit",
    errorMessage: "You’ve reached your Claude usage limit. Try again after it resets.",
    run: { status: "failed", errorCode: "usage_limit", errorMessage: "You’ve reached your Claude usage limit." },
    events: [{ type: "failed", message: "Attempt 1 failed: You’ve reached your Claude usage limit." }],
  });
  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByText("You’ve reached your Claude usage limit. Try again after it resets.")).toBeVisible();
  await page.getByRole("button", { name: `Retry ${task.title}` }).click();

  await expect(statusBadge(page)).toContainText("Queued");
  await expect(page.getByText("Attempt 2", { exact: true })).toBeVisible();
  expect((await runsOfTask(task.id)).map((run) => [run.attempt, run.status])).toEqual([
    [1, "failed"],
    [2, "pending"],
  ]);
});

test("an interrupted task explains why and offers Retry", async ({ page }) => {
  const agent = await createAgent();
  const { task } = await createTask(agent.id, {
    status: "interrupted",
    errorCode: "worker_stopped",
    errorMessage: "The worker stopped while an action waited for your approval. That request can’t be resumed.",
    run: { status: "failed", errorCode: "worker_stopped" },
  });
  await page.goto(`/tasks/${task.id}`);
  await expect(statusBadge(page)).toContainText("Interrupted");
  await expect(page.getByText("That request can’t be resumed.")).toBeVisible();
  await expect(page.getByRole("button", { name: `Retry ${task.title}` })).toBeVisible();
});

test("a task waiting for approval shows the exact input, and Approve records the decision", async ({ page }) => {
  const agent = await createAgent();
  const { task, run } = await createTask(agent.id, {
    status: "awaiting_approval",
    startedAt: now(),
    run: { status: "running", startedAt: now(), heartbeatAt: now() },
    events: [{ type: "approval_requested", message: "Waiting for your approval to run Read workspace file: notes/plan.md" }],
  });
  const call = await createToolCall(run.id);
  await page.goto("/tasks?status=awaiting_approval");
  await expect(page.getByRole("link", { name: task.title })).toBeVisible();
  await page.getByRole("link", { name: task.title }).click();

  const card = page.getByRole("region", { name: "Approval needed: Read workspace file" });
  await expect(card).toContainText('"path": "notes/plan.md"');
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card.getByRole("button", { name: "Approved" })).toBeDisabled();
  expect((await toolCallById(call.id)).status).toBe("approved");
});

test("filters by status and searches, with counts, all in the URL", async ({ page }) => {
  const researcher = await createAgent();
  const writer = await createAgent({ name: "Writer", role: "writing" });
  await createTask(researcher.id, { title: "Compare frameworks", status: "completed", result: "Done", run: { status: "completed" } });
  await createTask(writer.id, { title: "Draft a newsletter", status: "running", run: { status: "running", heartbeatAt: now() } });
  await createTask(writer.id, { title: "Old idea", status: "cancelled", run: { status: "cancelled" } });
  await createTask(researcher.id, { title: "Lost one", status: "interrupted", run: { status: "failed" } });

  await page.goto("/tasks");
  const filters = page.getByRole("navigation", { name: "Filter tasks by status" });
  await expect(filters.getByRole("link", { name: "All 4" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("list").filter({ hasText: "Compare frameworks" }).getByRole("listitem")).toHaveCount(4);

  await filters.getByRole("link", { name: /^Completed/ }).click();
  await expect(page).toHaveURL(/status=completed/);
  await expect(page.getByRole("link", { name: "Compare frameworks" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Draft a newsletter" })).toBeHidden();

  await filters.getByRole("link", { name: /^Cancelled \/ Interrupted 2/ }).click();
  await expect(page.getByRole("link", { name: "Old idea" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Lost one" })).toBeVisible();

  // Search keeps the filter, and looks at agent names too.
  await page.getByRole("searchbox", { name: "Search tasks" }).fill("writer");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/q=writer/);
  await expect(page).toHaveURL(/status=stopped/);
  await expect(page.getByRole("link", { name: "Old idea" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Lost one" })).toBeHidden();
  await expect(filters.getByRole("link", { name: "All 2" })).toBeVisible();

  await page.getByRole("searchbox", { name: "Search tasks" }).fill("nothing like this");
  await page.keyboard.press("Enter");
  await expect(page.getByText("No cancelled / interrupted tasks match “nothing like this”")).toBeVisible();
  await page.getByRole("link", { name: "Show all tasks" }).click();
  await expect(page).toHaveURL(/\/tasks$/);
});

test("keyboard only: filter, open a task, and create one", async ({ page }) => {
  const agent = await createAgent();
  await createTask(agent.id, { title: "Keyboard task" });
  await page.goto("/tasks");

  await page.getByRole("searchbox", { name: "Search tasks" }).focus();
  await page.keyboard.press("Tab"); // first filter link
  await expect(page.getByRole("link", { name: /^All/ })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter"); // Queued
  await expect(page).toHaveURL(/status=queued/);

  await page.getByRole("link", { name: "Keyboard task" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Keyboard task" })).toBeVisible();

  await page.goto("/tasks/new");
  // The form streams in and hydrates; focus it once the page has settled.
  await page.waitForLoadState("networkidle");
  await agentField(page).focus();
  await expect(agentField(page)).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.type("Typed with the keyboard");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Do it without a mouse.");
  await page.keyboard.press("Tab"); // Cancel link
  await page.keyboard.press("Tab"); // Create task
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: "Typed with the keyboard" })).toBeVisible();
});

for (const theme of ["Light", "Dark"] as const) {
  test(`task pages read well on a phone in the ${theme.toLowerCase()} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme: theme === "Dark" ? "dark" : "light" });
    const agent = await createAgent({ name: "Research Assistant with a rather long name" });
    const { task } = await createTask(agent.id, {
      title: "A task with a long title that has to wrap neatly on a small phone screen",
      status: "completed",
      result: "A result with a long line: " + "word ".repeat(80),
      run: { status: "completed", startedAt: now(), finishedAt: now(), modelId: "claude-opus-5-5", inputTokens: 10, outputTokens: 5 },
      events: [{ type: "completed", message: "Completed. The result is saved." }],
    });

    for (const path of ["/tasks", `/tasks/${task.id}`, "/tasks/new"]) {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme.toLowerCase());
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), path).toBe(true);
    }

    // Text stays readable on the page background (WCAG AA).
    await page.goto(`/tasks/${task.id}`);
    const [background, text, muted] = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!;
      const toRgb = (color: string) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
        return [r / 255, g / 255, b / 255] as [number, number, number];
      };
      const timeline = document.querySelector('ol[aria-label="Task events"] p')!;
      const meta = document.querySelector('ol[aria-label="Task events"] p + p')!;
      return [
        toRgb(getComputedStyle(document.body).backgroundColor),
        toRgb(getComputedStyle(timeline).color),
        toRgb(getComputedStyle(meta).color),
      ];
    });
    expect(contrastRatio(background, text)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(background, muted)).toBeGreaterThanOrEqual(4.5);
  });
}

function luminance([r, g, b]: [number, number, number]): number {
  const linear = (channel: number) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}
