import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { addWorkerFailure, createWorkerInstance, db, notificationPreferences, resetDatabase } from "./database";

// Settings for M6C in a real browser, against the isolated e2e database:
// worker health (seeded as a worker would report it; no worker runs here) and
// notification preferences (saved through the real Server Action).

test.beforeEach(async () => {
  await resetDatabase();
});

const indicator = (page: Page) => page.getByRole("link", { name: /^Worker/ });
const workerSection = (page: Page) => page.getByRole("region", { name: "Worker", exact: true });

test("with no worker report yet, Settings and the header say so", async ({ page }) => {
  await page.goto("/settings");
  await expect(indicator(page)).toHaveAccessibleName("Worker: Not seen yet");
  await expect(workerSection(page).getByText("Not seen yet")).toBeVisible();
  await expect(workerSection(page).getByText("No worker has reported yet", { exact: false })).toBeVisible();
});

test("a live worker whose steps succeed is running; the header links to the details", async ({ page }) => {
  await createWorkerInstance({ pid: 4242 });
  await page.goto("/");
  await expect(indicator(page)).toHaveAccessibleName("Worker: Running");
  await indicator(page).click();
  await page.waitForURL("/settings#worker");
  const section = workerSection(page);
  await expect(section.getByText("process 4242")).toBeVisible();
  await expect(section.getByRole("region", { name: /process 4242/ }).getByText("Working")).toHaveCount(3);
  await expect(section.getByText("can’t start or stop the worker", { exact: false })).toBeVisible();
});

test("a failing step makes it degraded and shows the safe message", async ({ page }) => {
  const id = await createWorkerInstance();
  await addWorkerFailure(id, "scheduler");
  await page.goto("/settings");
  await expect(indicator(page)).toHaveAccessibleName("Worker: Degraded");
  const section = workerSection(page);
  await expect(section.getByText("Failing", { exact: true })).toBeVisible();
  await expect(section.getByRole("heading", { name: "Recent problems" })).toBeVisible();
  await expect(section.getByRole("listitem").filter({ hasText: "Scheduler:" })).toContainText("A database query failed. (PostgreSQL 42P01)");
});

test("a heartbeat that stopped means not responding; a graceful stop means stopped", async ({ page }) => {
  await createWorkerInstance({ heartbeatSecondsAgo: 300 });
  await page.goto("/settings");
  await expect(indicator(page)).toHaveAccessibleName("Worker: Not responding");
  await expect(workerSection(page).getByText("Stopped reporting", { exact: true })).toBeVisible();

  await resetDatabase();
  await createWorkerInstance({ heartbeatSecondsAgo: 120, stopped: true });
  await page.reload();
  await expect(indicator(page)).toHaveAccessibleName("Worker: Stopped");
  await expect(workerSection(page).getByText("Stopped normally", { exact: true })).toBeVisible();
});

test("notification preferences: every kind on by default; a change is saved and survives a reload (keyboard only)", async ({ page }) => {
  await page.goto("/settings#notifications");
  const failed = page.getByRole("switch", { name: "Failed tasks" });
  await expect(page.getByRole("switch")).toHaveCount(8);
  for (const s of await page.getByRole("switch").all()) await expect(s).toHaveAttribute("aria-checked", "true");

  await failed.focus();
  await expect(failed).toBeFocused();
  await page.keyboard.press("Space");
  await expect(failed).toHaveAttribute("aria-checked", "false");
  await expect.poll(async () => (await db.select().from(notificationPreferences).where(eq(notificationPreferences.kind, "task_failed")))[0]?.enabled).toBe(false);

  await page.reload();
  await expect(page.getByRole("switch", { name: "Failed tasks" })).toHaveAttribute("aria-checked", "false");
  await page.getByRole("switch", { name: "Failed tasks" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("switch", { name: "Failed tasks" })).toHaveAttribute("aria-checked", "true");
  await expect.poll(async () => (await db.select().from(notificationPreferences).where(eq(notificationPreferences.kind, "task_failed")))[0]?.enabled).toBe(true);
});

test("the approval switch explains that requests still wait on the task", async ({ page }) => {
  await page.goto("/settings");
  const approval = page.getByRole("switch", { name: "Approval requests" });
  await expect(approval).toHaveAccessibleDescription(/the request still waits on the task or conversation/);
});

for (const theme of ["light", "dark"] as const) {
  test(`Settings with several workers fits a phone, a tablet, and a desktop in the ${theme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    const live = await createWorkerInstance({ pid: 51234 });
    await addWorkerFailure(live, "notifications", "Couldn’t reach PostgreSQL. Is the database running?");
    await createWorkerInstance({ pid: 51111, heartbeatSecondsAgo: 900 });
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/settings");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(workerSection(page).getByText("process 51234")).toBeVisible();
      await expect(indicator(page)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `/settings at ${width} (${theme})`).toBe(true);
    }
  });
}
