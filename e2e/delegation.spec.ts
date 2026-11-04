import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  addTaskEvent,
  agentDelegationTargets,
  createAgent,
  createDelegation,
  createTask,
  createToolCall,
  db,
  resetDatabase,
  runs,
  taskById,
  taskDelegations,
  tasks,
  toolCallById,
} from "./database";

// Delegation between agents (M5A) in a real browser. No worker runs here:
// the worker's writes are made directly in the database, as it makes them.
// The delegation flow itself (tool, rules, child runs, follow-up) is covered
// by the Vitest suites.

test.beforeEach(async () => {
  await resetDatabase();
});

const now = () => new Date();
const pageHeader = (page: Page) => page.getByRole("main").locator("header").first();

/** A parent task waiting on a running child, as the worker leaves it after a delegation. */
async function waitingParent() {
  const researcher = await createAgent({ name: "Research Assistant" });
  const writer = await createAgent({ name: "Writing Assistant", role: "writing" });
  await db.insert(agentDelegationTargets).values({ agentId: researcher.id, targetAgentId: writer.id });
  const { task: parent } = await createTask(researcher.id, {
    title: "Compare AI systems",
    status: "waiting_on_delegate",
    startedAt: now(),
    run: { status: "completed", startedAt: now(), finishedAt: now() },
    events: [
      { type: "delegated", message: "Delegated to Writing Assistant: Turn the findings into a short report" },
      { type: "waiting_on_delegate", message: "Waiting for Writing Assistant to finish the delegated task." },
    ],
  });
  const child = await createDelegation(parent, writer.id, {
    child: { status: "running", startedAt: now(), run: { status: "running", startedAt: now(), heartbeatAt: now() } },
  });
  return { researcher, writer, parent, child };
}

test("Agent Builder: delegation is off by default, can be limited to chosen agents, and shows on the agent page", async ({ page }) => {
  const researcher = await createAgent({ name: "Research Assistant" });
  await createAgent({ name: "Writing Assistant", role: "writing" });
  await createAgent({ name: "Editor", role: "editing", enabled: false });

  await page.goto(`/agents/${researcher.id}`);
  await expect(page.getByText("Off. This agent does all of its tasks itself.")).toBeVisible();
  await page.getByRole("link", { name: "Edit" }).click();

  const delegationSwitch = page.getByRole("switch", { name: "Can delegate tasks" });
  await expect(delegationSwitch).toHaveAttribute("aria-checked", "false");
  // Keyboard: focus the switch, turn it on with Space.
  await delegationSwitch.focus();
  await page.keyboard.press("Space");
  const target = (name: string) => page.getByRole("checkbox", { name: new RegExp(`^${name}`) });
  await expect(target("Writing Assistant")).toBeVisible();
  await expect(target("Research Assistant")).toHaveCount(0); // never itself
  await expect(page.getByText("Disabled", { exact: true })).toBeVisible(); // the disabled Editor is marked

  // On, but nothing chosen: refused with a message next to the section.
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Choose at least one agent, or turn delegation off.")).toBeVisible();

  await target("Writing Assistant").check();
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(`/agents/${researcher.id}`);
  const section = page.locator("section").filter({ hasText: "Checked by Solas on every delegation." });
  await expect(section.getByRole("link", { name: "Writing Assistant" })).toBeVisible();
  let saved = await db.select().from(agentDelegationTargets).where(eq(agentDelegationTargets.agentId, researcher.id));
  expect(saved).toHaveLength(1);

  // Turning it off removes the permission.
  await page.getByRole("link", { name: "Edit" }).click();
  await page.getByRole("switch", { name: "Can delegate tasks" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(`/agents/${researcher.id}`);
  saved = await db.select().from(agentDelegationTargets).where(eq(agentDelegationTargets.agentId, researcher.id));
  expect(saved).toHaveLength(0);
});

test("a waiting parent shows its delegated task, which links back, and both follow the worker", async ({ page }) => {
  const { parent, child } = await waitingParent();
  await page.goto(`/tasks/${parent.id}`);
  await expect(pageHeader(page)).toContainText("Waiting on agent");
  await expect(page.getByText("Waiting for Writing Assistant.")).toBeVisible();
  const card = page.getByRole("article", { name: "Delegated to Writing Assistant" });
  await expect(card).toContainText("Running");
  await card.getByText("What Research Assistant sent").click();
  await expect(card).toContainText("Turn these findings into a short report: A is fast, B is safe.");
  await expect(card).toContainText("Expected output: Three bullet points");

  // The child, finishing: the parent's card follows without a reload.
  await db.update(runs).set({ status: "completed", finishedAt: now() }).where(eq(runs.id, child.run.id));
  await db.update(tasks).set({ status: "completed", result: "- **A** is fast\n- **B** is safe", finishedAt: now() }).where(eq(tasks.id, child.task.id));
  await db.update(taskDelegations).set({ status: "completed", completedAt: now() }).where(eq(taskDelegations.id, child.delegation.id));
  await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, parent.id));
  await expect(card).toContainText("Completed");
  await expect(card.getByText("Writing Assistant’s result")).toBeVisible();
  await expect(card.locator("strong").first()).toHaveText("A");

  // The parent finishes with its own final result.
  await db.update(tasks).set({ status: "completed", result: "Final report from the researcher.", finishedAt: now() }).where(eq(tasks.id, parent.id));
  await addTaskEvent(parent.id, child.run.id, "completed", "Completed. The result is saved.");
  await expect(pageHeader(page)).toContainText("Completed");
  await expect(page.getByText("Final report from the researcher.")).toBeVisible();

  // Navigate to the child and back.
  await card.getByRole("link", { name: "Turn the findings into a short report" }).click();
  await expect(page.getByText("Delegated by Research Assistant")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Request from Research Assistant" })).toBeVisible();
  await page.getByRole("link", { name: "Compare AI systems" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Compare AI systems" })).toBeVisible();
});

test("the child's approval request can be decided from the parent's page", async ({ page }) => {
  const { parent, child } = await waitingParent();
  await db.update(tasks).set({ status: "awaiting_approval" }).where(eq(tasks.id, child.task.id));
  const call = await createToolCall(child.run.id);
  await page.goto(`/tasks/${parent.id}`);
  const approval = page.getByRole("region", { name: "Approval needed: Read workspace file" });
  await expect(approval).toContainText("Writing Assistant wants to use Read workspace file");
  await approval.getByRole("button", { name: "Reject" }).click();
  await expect(approval.getByRole("button", { name: "Rejected" })).toBeDisabled();
  expect((await toolCallById(call.id)).status).toBe("rejected");
});

test("cancelling the parent cancels its delegated task", async ({ page }) => {
  const { parent, child } = await waitingParent();
  await page.goto(`/tasks/${parent.id}`);
  await page.getByRole("button", { name: `Cancel ${parent.title}` }).click();
  await expect(pageHeader(page)).toContainText("Cancelled");
  expect((await taskById(parent.id)).status).toBe("cancelled");
  // The running child gets a cancel request the worker acts on.
  expect((await taskById(child.task.id)).cancelRequestedAt).not.toBeNull();
  const [link] = await db.select().from(taskDelegations).where(eq(taskDelegations.id, child.delegation.id));
  expect(link.status).toBe("cancelled");
});

test("the task list marks delegated tasks", async ({ page }) => {
  await waitingParent();
  await page.goto("/tasks");
  const childRow = page.getByRole("listitem").filter({ hasText: "Turn the findings into a short report" });
  await expect(childRow).toContainText("Writing Assistant · delegated by Research Assistant");
  await expect(page.getByRole("listitem").filter({ hasText: "Compare AI systems" })).toContainText("Waiting on agent");
});

for (const theme of ["Light", "Dark"] as const) {
  test(`a delegation reads well on a phone in the ${theme.toLowerCase()} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme: theme === "Dark" ? "dark" : "light" });
    const { parent, child, researcher } = await waitingParent();
    for (const path of [`/tasks/${parent.id}`, `/tasks/${child.task.id}`, `/agents/${researcher.id}`, `/agents/${researcher.id}/edit`]) {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme.toLowerCase());
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), path).toBe(true);
    }
  });
}
