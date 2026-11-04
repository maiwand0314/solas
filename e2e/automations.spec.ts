import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  addOccurrence,
  automationOccurrences,
  automations,
  createAgent,
  createAutomation,
  createTask,
  db,
  resetDatabase,
  runs,
  tasks,
} from "./database";

// Automations (M6A) in a real browser, against the isolated e2e database.
// No worker runs here, so the scheduler never fires and no AI task executes:
// history is seeded the way the scheduler would write it.

test.beforeEach(async () => {
  await resetDatabase();
});

const pageHeader = (page: Page) => page.getByRole("main").locator("header").first();
const section = (page: Page, heading: string) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: heading, exact: true }) });
const BRIEFING =
  "Summarize the latest developments in AI and software engineering. Clearly distinguish verified findings from " +
  "information that cannot be checked with currently available tools.";

test("demo: creates the Daily AI Research Briefing (every day at 08:00, Europe/Oslo)", async ({ page }) => {
  const agent = await createAgent({ name: "Research Assistant", role: "research" });

  await page.goto("/");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Automations" }).click();
  await expect(page.getByText("No automations yet")).toBeVisible();
  await page.getByRole("link", { name: "New automation" }).first().click();

  await page.getByLabel("Name").fill("Daily AI Research Briefing");
  await page.getByLabel("Description").fill("A morning summary for me to read.");
  await expect(page.locator('select[name="agentId"]')).toHaveValue(agent.id);
  await page.getByLabel("Task instructions").fill(BRIEFING);
  // The defaults are already "Every day at 08:00" in Europe/Oslo.
  await expect(page.locator('select[name="kind"]')).toHaveValue("daily");
  await expect(page.locator('input[name="time"]')).toHaveValue("08:00");
  await expect(page.locator('select[name="timeZone"]')).toHaveValue("Europe/Oslo");
  await expect(page.getByText("If you save now, it runs next:")).toBeVisible();
  await page.getByRole("button", { name: "Create automation" }).click();
  await page.waitForURL(/\/automations\/[0-9a-f-]{36}$/);

  const [row] = await db.select().from(automations);
  expect(row).toMatchObject({
    name: "Daily AI Research Briefing",
    agentId: agent.id,
    instructions: BRIEFING,
    schedule: { kind: "daily", time: "08:00" },
    timeZone: "Europe/Oslo",
    enabled: true,
  });
  // The next run is 08:00 in Oslo, today or tomorrow.
  const oslo = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  expect(oslo.format(row.nextRunAt!)).toBe("08:00");
  expect(row.nextRunAt!.getTime() - Date.now()).toBeLessThanOrEqual(24 * 60 * 60_000);

  await expect(pageHeader(page)).toContainText("Daily AI Research Briefing");
  const schedule = section(page, "Schedule");
  await expect(schedule).toContainText("Every day at 08:00");
  await expect(schedule).toContainText("Europe/Oslo");
  await expect(schedule).toContainText("Active");
  await expect(page.getByRole("list", { name: "Upcoming runs" }).getByRole("listitem")).toHaveCount(5);
  await expect(section(page, "History")).toContainText("No runs yet");
  // Saving it created no task: runs only start from the worker's scheduler (or Run now).
  expect(await db.select().from(tasks)).toHaveLength(0);

  await page.getByRole("link", { name: "Automations" }).first().click();
  const list = page.getByRole("region", { name: "Automations" });
  await expect(list).toContainText("Daily AI Research Briefing");
  await expect(list).toContainText("Research Assistant");
  await expect(list).toContainText("Every day at 08:00 · Europe/Oslo");
  await expect(list).toContainText("Next:");
});

test("validates schedules in the form and on the server", async ({ page }) => {
  await createAgent({ name: "Research Assistant" });
  await page.goto("/automations/new");
  await page.getByLabel("Name").fill("Too often");
  await page.getByLabel("Task instructions").fill("Check something.");
  await page.locator('select[name="kind"]').selectOption("interval");
  await page.locator('input[name="every"]').fill("5");
  await page.locator('select[name="unit"]').selectOption("minutes");
  await page.getByRole("button", { name: "Create automation" }).click();
  await expect(page.getByText("to keep Claude usage reasonable")).toBeVisible();

  await page.locator('select[name="kind"]').selectOption("once");
  await page.locator('input[name="date"]').fill("2020-01-01");
  await page.locator('input[name="time"]').fill("08:00");
  await expect(page.getByText("This time has already passed")).toBeVisible(); // the preview says so
  await page.getByRole("button", { name: "Create automation" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "This time has already passed" })).toBeVisible(); // and the server refuses
  expect(await db.select().from(automations)).toHaveLength(0);
});

test("edits the schedule, pauses, and resumes", async ({ page }) => {
  const agent = await createAgent({ name: "Research Assistant" });
  const automation = await createAutomation(agent.id);

  await page.goto(`/automations/${automation.id}`);
  await page.getByRole("link", { name: "Edit" }).click();
  await page.locator('select[name="kind"]').selectOption("weekly");
  await page.getByRole("checkbox", { name: "Monday" }).uncheck();
  await page.getByRole("checkbox", { name: "Wednesday" }).check();
  await page.getByRole("checkbox", { name: "Friday" }).check();
  await page.locator('input[name="time"]').fill("09:30");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(`/automations/${automation.id}`);
  await expect(section(page, "Schedule")).toContainText("Every Wednesday and Friday at 09:30");
  const [edited] = await db.select().from(automations);
  expect(edited.schedule).toEqual({ kind: "weekly", days: [3, 5], time: "09:30" });

  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  await expect(section(page, "Schedule")).toContainText("None while paused");
  expect((await db.select().from(automations))[0]).toMatchObject({ enabled: false, nextRunAt: null });

  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  const [resumed] = await db.select().from(automations);
  expect(resumed.enabled).toBe(true);
  expect(resumed.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
});

test("shows the run history; a run opens its task, and the task links back", async ({ page }) => {
  const agent = await createAgent({ name: "Research Assistant" });
  const automation = await createAutomation(agent.id);
  const { task: done } = await createTask(agent.id, {
    title: "Daily AI Research Briefing — Wed 4 Nov 2026, 08:00",
    automationId: automation.id,
    status: "completed",
    result: "## Briefing\n\nVerified: nothing could be checked, because this agent has no web access.",
    finishedAt: new Date(),
    run: { status: "completed" },
  });
  const { task: failed } = await createTask(agent.id, {
    title: "Daily AI Research Briefing — Tue 3 Nov 2026, 08:00",
    automationId: automation.id,
    status: "failed",
    errorCode: "usage_limit",
    errorMessage: "You’ve reached your Claude usage limit. Try again after it resets.",
    run: { status: "failed" },
  });
  await addOccurrence(automation.id, {
    scheduledFor: new Date("2026-11-04T07:00:00Z"),
    status: "started",
    message: "Started on schedule.",
    taskId: done.id,
  });
  await addOccurrence(automation.id, {
    scheduledFor: new Date("2026-11-03T07:00:00Z"),
    status: "started",
    message: "Started on schedule.",
    taskId: failed.id,
  });
  await addOccurrence(automation.id, {
    scheduledFor: new Date("2026-11-01T07:00:00Z"),
    status: "missed",
    missedCount: 2,
    message: "Missed 2 runs from Sun 1 Nov 2026, 08:00 to Mon 2 Nov 2026, 08:00: the worker wasn’t running.",
  });
  await addOccurrence(automation.id, {
    scheduledFor: new Date("2026-10-31T07:00:00Z"),
    status: "skipped",
    reason: "agent_unavailable",
    message: "Skipped: “Research Assistant” is disabled.",
  });

  await page.goto(`/automations/${automation.id}`);
  const history = page.getByRole("list", { name: "Run history" });
  await expect(history.getByRole("listitem")).toHaveCount(4);
  await expect(section(page, "History")).toContainText("2 started · 2 missed · 1 skipped");
  await expect(history.getByRole("listitem").nth(1)).toContainText("Failed");
  await expect(history.getByRole("listitem").nth(1)).toContainText("usage limit");
  await expect(history).toContainText("Missed ×2");
  await expect(history).toContainText("Skipped");
  await expect(section(page, "Latest result")).toContainText("Verified: nothing could be checked");

  // A run opens its task; the task shows where it came from.
  await history.getByRole("link", { name: "Wed 4 Nov 2026, 08:00" }).click();
  await page.waitForURL(`/tasks/${done.id}`);
  await expect(pageHeader(page)).toContainText("From automation Daily AI Research Briefing");
  await page.getByRole("link", { name: "Daily AI Research Briefing", exact: true }).click();
  await page.waitForURL(`/automations/${automation.id}`);

  await page.goto("/tasks");
  await expect(page.getByText("from Daily AI Research Briefing").first()).toBeVisible();
});

test("Run now asks first, then queues a real task (no worker here, so it stays queued)", async ({ page }) => {
  const agent = await createAgent({ name: "Research Assistant" });
  const automation = await createAutomation(agent.id);

  await page.goto(`/automations/${automation.id}`);
  await page.getByRole("button", { name: "Run now…" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Run “Daily AI Research Briefing” now?" });
  await expect(dialog).toContainText("one Claude run on your plan");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Run now" }).click();
  await expect(dialog).toBeHidden();

  const history = page.getByRole("list", { name: "Run history" });
  await expect(history.getByRole("listitem")).toHaveCount(1);
  await expect(history).toContainText("Queued");
  await expect(history).toContainText("Run now");
  const [task] = await db.select().from(tasks);
  expect(task).toMatchObject({ automationId: automation.id, status: "queued", agentId: agent.id });
  expect(await db.select().from(runs).where(eq(runs.taskId, task.id))).toMatchObject([{ status: "pending" }]);

  // A second Run now while that run is queued is refused: runs never overlap.
  await page.getByRole("button", { name: "Run now…" }).first().click();
  await dialog.getByRole("button", { name: "Run now" }).click();
  await expect(dialog.getByRole("alert")).toContainText("previous run of this automation hadn’t finished");
  expect(await db.select().from(tasks)).toHaveLength(1);
});

test("a missed one-time run is shown plainly, with a way to run it", async ({ page }) => {
  const agent = await createAgent({ name: "Research Assistant" });
  const automation = await createAutomation(agent.id, {
    name: "Quarterly review",
    schedule: { kind: "once", date: "2026-11-01", time: "09:00" },
    nextRunAt: null,
  });
  await addOccurrence(automation.id, {
    scheduledFor: new Date("2026-11-01T08:00:00Z"),
    status: "missed",
    missedCount: 1,
    message: "Missed: the worker wasn’t running at Sun 1 Nov 2026, 09:00.",
  });

  await page.goto("/automations");
  await expect(page.getByRole("region", { name: "Automations" })).toContainText("Missed");
  await expect(page.getByText("1 missed, needs you")).toBeVisible();
  await page.getByRole("link", { name: "Quarterly review" }).click();
  await expect(page.getByText("The one-time run was missed")).toBeVisible();
  await expect(page.getByText("It was due at Sun 1 Nov 2026, 09:00")).toBeVisible();
  await expect(page.getByRole("link", { name: "Choose a new time" })).toBeVisible();
});

test("deleting an automation keeps the tasks it created", async ({ page }) => {
  const agent = await createAgent({ name: "Research Assistant" });
  const automation = await createAutomation(agent.id);
  const { task } = await createTask(agent.id, { title: "Briefing", automationId: automation.id, status: "completed", run: { status: "completed" } });
  await addOccurrence(automation.id, { scheduledFor: new Date(), status: "started", message: "Started.", taskId: task.id });

  await page.goto(`/automations/${automation.id}`);
  await page.getByRole("button", { name: "Delete automation…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete “Daily AI Research Briefing”?" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Delete automation" }).click();
  await page.waitForURL("/automations");
  await expect(page.getByText("No automations yet")).toBeVisible();

  expect(await db.select().from(automations)).toHaveLength(0);
  expect(await db.select().from(automationOccurrences)).toHaveLength(0);
  const [kept] = await db.select().from(tasks).where(eq(tasks.id, task.id));
  expect(kept).toMatchObject({ title: "Briefing", automationId: null });
});

for (const theme of ["light", "dark"] as const) {
  test(`automation pages fit a phone and a tablet in the ${theme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    const agent = await createAgent({ name: "Research Assistant" });
    const automation = await createAutomation(agent.id, {
      description: "A morning summary of what changed in AI and software engineering, for me to read with coffee.",
    });
    const { task } = await createTask(agent.id, {
      title: "Daily AI Research Briefing — Wed 4 Nov 2026, 08:00",
      automationId: automation.id,
      status: "completed",
      result: "A short, honest briefing.",
      run: { status: "completed" },
    });
    await addOccurrence(automation.id, { scheduledFor: new Date(), status: "started", message: "Started.", taskId: task.id });

    for (const width of [375, 768]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of ["/automations", `/automations/${automation.id}`, "/automations/new", `/automations/${automation.id}/edit`]) {
        await page.goto(path);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          `${path} at ${width} (${theme})`,
        ).toBe(true);
      }
    }
  });
}
