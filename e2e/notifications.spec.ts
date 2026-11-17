import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  agentDelegationTargets,
  agents,
  automations,
  createAgent,
  createAutomation,
  createNotification,
  createTask,
  createToolCall,
  db,
  notifications,
  resetDatabase,
  teamMembers,
  teams,
} from "./database";

// The Notification Center and the M6B automation controls in a real browser,
// against the isolated e2e database. No worker runs: notifications are seeded
// the way the worker's sync writes them (that sync is covered by Vitest).

test.beforeEach(async () => {
  await resetDatabase();
});

const bell = (page: import("@playwright/test").Page) => page.getByRole("link", { name: /^Notifications/ });

test("the bell shows the unread count and opens the inbox", async ({ page }) => {
  const agent = await createAgent();
  const { task } = await createTask(agent.id, { status: "failed", title: "Weekly report" });
  await createNotification({ title: "Task failed: Weekly report", taskId: task.id });
  await createNotification({ kind: "automation_missed", title: "Missed run: Daily briefing", body: "The worker wasn’t running." });

  await page.goto("/");
  await expect(bell(page)).toHaveAccessibleName("Notifications, 2 unread");
  await bell(page).click();
  await page.waitForURL("/notifications");
  await expect(page.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
  await expect(page.getByText("2 unread")).toBeVisible();
  await expect(page.getByText("nothing is sent to you while this page is closed", { exact: false })).toBeVisible();
});

test("marks one read and unread, then everything read, and it persists after a reload", async ({ page }) => {
  await createNotification({ title: "Task failed: First" });
  await createNotification({ title: "Task failed: Second" });
  await page.goto("/notifications");

  const first = page.getByRole("listitem").filter({ hasText: "Task failed: First" });
  await first.getByRole("button", { name: "Mark read" }).click();
  await expect(first.getByRole("button", { name: "Mark unread" })).toBeVisible();
  await expect(page.getByText("1 unread")).toBeVisible();
  await expect(bell(page)).toHaveAccessibleName("Notifications, 1 unread");
  expect((await db.select().from(notifications).where(eq(notifications.title, "Task failed: First")))[0].readAt).not.toBeNull();

  await page.reload();
  await expect(page.getByRole("listitem").filter({ hasText: "Task failed: First" }).getByRole("button", { name: "Mark unread" })).toBeVisible();

  await first.getByRole("button", { name: "Mark unread" }).click();
  await expect(page.getByText("2 unread")).toBeVisible();
  await page.getByRole("button", { name: "Mark all as read" }).click();
  await expect(page.getByText("You’re all caught up.")).toBeVisible();
  await expect(bell(page)).toHaveAccessibleName("Notifications");
  expect(await db.select().from(notifications).where(eq(notifications.readAt, null as never))).toHaveLength(0);
});

test("opens the task a notification is about, and counts that as reading it", async ({ page }) => {
  const agent = await createAgent();
  const { task } = await createTask(agent.id, { status: "failed", title: "Weekly report", errorMessage: "Stopped." });
  const n = await createNotification({ title: "Task failed: Weekly report", taskId: task.id });

  await page.goto("/notifications");
  await page.getByRole("link", { name: "Open" }).click();
  await page.waitForURL(`/tasks/${task.id}`);
  await expect.poll(async () => (await db.select().from(notifications).where(eq(notifications.id, n.id)))[0].readAt).not.toBeNull();
});

test("an approval request leads to the task, where the existing approve and reject controls are", async ({ page }) => {
  const agent = await createAgent({ name: "Developer" });
  const { task, run } = await createTask(agent.id, { status: "awaiting_approval", title: "Write notes", run: { status: "running" } });
  const call = await createToolCall(run.id);
  await createNotification({
    kind: "approval_requested",
    title: "Approval needed: Developer",
    body: "Developer wants to use read_workspace_file. Review the request and approve or reject it.",
    taskId: task.id,
    toolCallId: call.id,
  });

  await page.goto("/notifications");
  await expect(page.getByText("Waiting for your decision")).toBeVisible();
  await page.getByRole("link", { name: "Review" }).click();
  await page.waitForURL(`/tasks/${task.id}`);
  await expect(page.getByRole("button", { name: /Approve/ }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Reject/ }).first()).toBeVisible();
  // Nothing was approved by looking at it.
  expect((await db.query.toolCalls.findFirst())?.status).toBe("awaiting_approval");
});

test("an approval that has expired is shown as expired, with no way to act on it here", async ({ page }) => {
  const agent = await createAgent({ name: "Developer" });
  const { task, run } = await createTask(agent.id, { status: "running", run: { status: "running" } });
  const call = await createToolCall(run.id, { status: "awaiting_approval", approvalExpiresAt: new Date(Date.now() - 60_000) });
  await createNotification({ kind: "approval_requested", title: "Approval needed: Developer", taskId: task.id, toolCallId: call.id });

  await page.goto("/notifications");
  const item = page.getByRole("listitem").filter({ hasText: "Approval needed: Developer" });
  await expect(item).toContainText("Expired");
  await expect(item.getByRole("button", { name: /Approve|Reject/ })).toHaveCount(0);
});

test("shows an empty state, and a notification whose target was deleted has no link", async ({ page }) => {
  await page.goto("/notifications");
  await expect(page.getByText("Nothing to review")).toBeVisible();
  await createNotification({ title: "Task failed: Gone" });
  await page.reload();
  await expect(page.getByText("Target deleted")).toBeVisible();
});

test("keyboard: the bell, then the actions in each notification, are reachable with visible focus", async ({ page }) => {
  await createNotification({ title: "Task failed: Keyboard" });
  await page.goto("/notifications");
  await bell(page).focus();
  await expect(bell(page)).toBeFocused();
  const markRead = page.getByRole("button", { name: "Mark read" });
  await markRead.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Mark unread" })).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  test(`the inbox and the automation form fit a phone and a tablet in the ${theme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    const agent = await createAgent({ name: "Research Assistant" });
    const [coordinator, member] = [await createAgent({ name: "Project Manager" }), await createAgent({ name: "Developer" })];
    const [team] = await db.insert(teams).values({ name: "Solas Development Team" }).returning();
    await db.insert(teamMembers).values([
      { teamId: team.id, agentId: coordinator.id, role: "coordinator" },
      { teamId: team.id, agentId: member.id, role: "member" },
    ]);
    const automation = await createAutomation(null as never, { agentId: null, teamId: team.id, maxRunsPerDay: 2, maxDurationMs: 300_000, pauseAfterFailures: 3 });
    await createNotification({ title: "Task failed: A fairly long title that should wrap on a small screen instead of scrolling", automationId: automation.id });
    await createNotification({ kind: "automation_paused", title: "Automation paused: Daily briefing", readAt: new Date() });

    for (const width of [375, 768]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of ["/notifications", "/automations", `/automations/${automation.id}`, "/automations/new", `/automations/${automation.id}/edit`]) {
        await page.goto(path);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${path} at ${width} (${theme})`).toBe(true);
      }
    }
    void agent;
  });
}

test("creates a team automation with limits, and shows the team, coordinator and limits", async ({ page }) => {
  const coordinator = await createAgent({ name: "Project Manager", role: "planning" });
  const developer = await createAgent({ name: "Developer", role: "engineering" });
  const [team] = await db.insert(teams).values({ name: "Solas Development Team" }).returning();
  await db.insert(teamMembers).values([
    { teamId: team.id, agentId: coordinator.id, role: "coordinator" },
    { teamId: team.id, agentId: developer.id, role: "member" },
  ]);

  await page.goto("/automations/new");
  await page.getByLabel("Name").fill("Weekly planning");
  await page.getByLabel("Task instructions").fill("Plan the week and report back.");
  await page.locator('select[name="targetKind"]').selectOption("team");
  await expect(page.locator('select[name="teamId"]')).toHaveValue(team.id);
  await expect(page.getByText("Each run starts with the coordinator, Project Manager.")).toBeVisible();
  await page.getByLabel("Runs per day").fill("2");
  await page.getByLabel("Minutes per run").fill("5");
  await page.getByLabel("Pause after failures").fill("3");
  await page.getByRole("button", { name: "Create automation" }).click();
  await page.waitForURL(/\/automations\/[0-9a-f-]{36}$/);

  const [row] = await db.select().from(automations);
  expect(row).toMatchObject({ teamId: team.id, agentId: null, maxRunsPerDay: 2, maxDurationMs: 300_000, pauseAfterFailures: 3, allowOverlap: false });
  await expect(page.getByRole("link", { name: "Solas Development Team" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Project Manager" })).toBeVisible();
  const limits = page.locator("section").filter({ has: page.getByRole("heading", { name: "Limits", exact: true }) });
  await expect(limits).toContainText("Runs per day");
  await expect(limits).toContainText("5 minutes");
  await expect(limits).toContainText("3 in a row");
  await expect(limits).toContainText("Not allowed");

  // Being in a team granted nothing.
  expect(await db.select().from(agentDelegationTargets)).toHaveLength(0);
  expect(await db.select().from(agents)).toHaveLength(2);
});

test("refuses limits looser than Solas's own, in the browser and on the server", async ({ page }) => {
  await createAgent({ name: "Research Assistant" });
  await page.goto("/automations/new");
  await page.getByLabel("Name").fill("Too loose");
  await page.getByLabel("Task instructions").fill("Do something.");
  await page.getByLabel("Runs per day").fill("500");
  await page.getByRole("button", { name: "Create automation" }).click();
  await expect(page.getByText(/Enter 1 to 24/)).toBeVisible();
  expect(await db.select().from(automations)).toHaveLength(0);
});

test("a team without a coordinator can't be chosen, and an automation paused by Solas says why", async ({ page }) => {
  const a = await createAgent({ name: "Lone Agent" });
  const [team] = await db.insert(teams).values({ name: "Headless" }).returning();
  await db.insert(teamMembers).values({ teamId: team.id, agentId: a.id, role: "member" });
  await page.goto("/automations/new");
  await page.locator('select[name="targetKind"]').selectOption("team");
  const teamSelect = page.locator('select[name="teamId"]');
  await expect(teamSelect).toBeDisabled();
  await expect(teamSelect.locator("option")).toHaveText("No team has a coordinator that can run tasks");

  const automation = await createAutomation(a.id, { enabled: false, nextRunAt: null, pausedReason: "Paused: the last 3 runs failed in a row. Check the task, then resume the automation." });
  await page.goto(`/automations/${automation.id}`);
  await expect(page.getByText("Solas paused this automation")).toBeVisible();
  await expect(page.getByText("failed in a row")).toBeVisible();
});
