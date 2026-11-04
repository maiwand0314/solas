import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  agentDelegationTargets,
  agents,
  createAgent,
  createTask,
  db,
  resetDatabase,
  tasks,
  teamMembers,
  teams,
} from "./database";

// Teams (M5B) in a real browser, against the isolated e2e database. The
// demo team is created here, through the UI, and never in the owner's own
// database. No worker runs, so no AI task is executed.

test.beforeEach(async () => {
  await resetDatabase();
});

const pageHeader = (page: Page) => page.getByRole("main").locator("header").first();
const member = (page: Page, name: string) => page.getByRole("checkbox", { name: new RegExp(`^${name}`) });

async function trio() {
  const manager = await createAgent({ name: "Project Manager", role: "planning" });
  const developer = await createAgent({ name: "Developer", role: "engineering" });
  const researcher = await createAgent({ name: "Research Assistant", role: "research" });
  return { manager, developer, researcher };
}

test("demo: Solas Development Team with a coordinator, delegation, and team tasks", async ({ page }) => {
  const { manager, developer, researcher } = await trio();

  // Teams is in the main navigation.
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Teams" }).click();
  await expect(page.getByText("No teams yet")).toBeVisible();

  // 1. Create the team.
  await page.getByRole("link", { name: "New team" }).first().click();
  await page.getByLabel("Name").fill("Solas Development Team");
  await page.getByLabel("Description").fill("Plans, builds, and researches Solas.");
  await expect(page.getByLabel("Coordinator")).toBeDisabled(); // no members yet
  await member(page, "Project Manager").check();
  await member(page, "Developer").check();
  await member(page, "Research Assistant").check();
  await page.getByLabel("Coordinator").selectOption({ label: "Project Manager" });
  await page.getByRole("button", { name: "Create team" }).click();
  await page.waitForURL(/\/teams\/[0-9a-f-]{36}$/);
  const teamId = page.url().split("/").pop()!;

  // 2. Members and coordinator, from the database.
  await expect(pageHeader(page)).toContainText("Solas Development Team");
  const members = page.locator("section").filter({ has: page.getByRole("heading", { name: "Members" }) });
  await expect(members).toContainText("Project Manager coordinates.");
  await expect(members.getByRole("listitem").first()).toContainText("Project Manager");
  await expect(members.getByRole("listitem").first()).toContainText("Coordinator");
  const rows = await db.select().from(teamMembers).where(eq(teamMembers.teamId, teamId));
  expect(rows.map((row) => [row.agentId, row.role]).sort()).toEqual(
    [
      [manager.id, "coordinator"],
      [developer.id, "member"],
      [researcher.id, "member"],
    ].sort(),
  );

  // 3. Membership granted no delegation; set it explicitly (keyboard for the checkboxes).
  const delegation = page.locator("section").filter({ has: page.getByRole("heading", { name: "Delegation" }) });
  await expect(delegation.getByRole("listitem").filter({ hasText: "Project Manager" })).toContainText(
    "Doesn’t delegate in this team",
  );
  expect(await db.select().from(agentDelegationTargets)).toHaveLength(0);
  await delegation.getByRole("button", { name: "Edit delegation for Project Manager" }).click();
  await delegation.getByRole("checkbox", { name: "Developer" }).focus();
  await page.keyboard.press("Space");
  await delegation.getByRole("checkbox", { name: "Research Assistant" }).check();
  await delegation.getByRole("button", { name: "Save" }).click();
  await expect(delegation.getByRole("listitem").filter({ hasText: "Project Manager" })).toContainText(
    "May delegate to Developer, Research Assistant",
  );
  const targets = await db.select().from(agentDelegationTargets).where(eq(agentDelegationTargets.agentId, manager.id));
  expect(targets.map((row) => row.targetAgentId).sort()).toEqual([developer.id, researcher.id].sort());

  // 4. A task for the team: the form starts with the team and offers only its members.
  await page.getByRole("link", { name: "New task for this team" }).click();
  await expect(page.locator('select[name="teamId"]')).toHaveValue(teamId);
  await page.locator('select[name="agentId"]').selectOption({ label: "Developer — engineering" });
  await page.getByLabel("Title").fill("Build the Teams page");
  await page.getByLabel("Instructions").fill("Build the Teams page and its tests.");
  await page.getByRole("button", { name: "Create task" }).click();
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
  await expect(pageHeader(page)).toContainText("Team Solas Development Team");
  const [task] = await db.select().from(tasks);
  expect(task).toMatchObject({ teamId, agentId: developer.id });

  // 5. It shows on the team page (tasks and activity) and in the team's task list.
  await page.getByRole("link", { name: "Solas Development Team" }).click();
  await expect(page.locator("section").filter({ has: page.getByRole("heading", { name: "Tasks" }) })).toContainText(
    "Build the Teams page",
  );
  await expect(page.getByRole("list", { name: "Team activity" })).toContainText("You created this task for Developer.");
  await page.getByRole("link", { name: "All team tasks" }).click();
  await expect(page.getByText("Showing tasks given to")).toBeVisible();
  await expect(page.getByRole("link", { name: "Build the Teams page" })).toBeVisible();
});

test("edits a team: rename, remove a member, change the coordinator", async ({ page }) => {
  const { manager, developer, researcher } = await trio();
  const [team] = await db.insert(teams).values({ name: "Core" }).returning();
  await db.insert(teamMembers).values([
    { teamId: team.id, agentId: manager.id, role: "coordinator" },
    { teamId: team.id, agentId: developer.id },
    { teamId: team.id, agentId: researcher.id },
  ]);

  await page.goto(`/teams/${team.id}`);
  await page.getByRole("link", { name: "Edit" }).click();
  await page.getByLabel("Name").fill("Core Team");
  await member(page, "Research Assistant").uncheck();
  await page.getByLabel("Coordinator").selectOption({ label: "Developer" });
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(`/teams/${team.id}`);
  await expect(pageHeader(page)).toContainText("Core Team");
  await expect(page.getByText("Developer coordinates.")).toBeVisible();

  const rows = await db.select().from(teamMembers).where(eq(teamMembers.teamId, team.id));
  expect(rows.map((row) => [row.agentId, row.role]).sort()).toEqual(
    [
      [manager.id, "member"],
      [developer.id, "coordinator"],
    ].sort(),
  );
});

test("deleting a team keeps its agents and tasks", async ({ page }) => {
  const { manager, developer } = await trio();
  const [team] = await db.insert(teams).values({ name: "Short-lived" }).returning();
  await db.insert(teamMembers).values([
    { teamId: team.id, agentId: manager.id },
    { teamId: team.id, agentId: developer.id },
  ]);
  const { task } = await createTask(developer.id, { title: "Kept task", teamId: team.id });

  await page.goto(`/teams/${team.id}`);
  await page.getByRole("button", { name: "Delete team…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete “Short-lived”?" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Delete team" }).click();
  await page.waitForURL("/teams");

  expect(await db.select().from(teams)).toHaveLength(0);
  expect(await db.select().from(agents)).toHaveLength(3);
  const [kept] = await db.select().from(tasks).where(eq(tasks.id, task.id));
  expect(kept).toMatchObject({ title: "Kept task", teamId: null });
});

test("searches and filters teams; the agent page lists its teams; a deleted agent leaves its teams", async ({ page }) => {
  const { manager, developer, researcher } = await trio();
  const [build] = await db.insert(teams).values({ name: "Build", description: "Ships features" }).returning();
  const [learn] = await db.insert(teams).values({ name: "Learn", description: "Reads papers" }).returning();
  await db.insert(teamMembers).values([
    { teamId: build.id, agentId: manager.id, role: "coordinator" },
    { teamId: build.id, agentId: developer.id },
    { teamId: learn.id, agentId: researcher.id },
  ]);

  await page.goto("/teams");
  const list = page.getByRole("region", { name: "Teams" });
  await page.getByRole("searchbox", { name: "Search teams" }).fill("papers");
  await expect(list.getByRole("link", { name: "Learn" })).toBeVisible();
  await expect(list.getByRole("link", { name: "Build" })).toBeHidden();
  await page.getByRole("searchbox", { name: "Search teams" }).fill("");
  await page.getByLabel("Filter by agent").selectOption({ label: "With Developer" });
  await expect(list.getByRole("link", { name: "Build" })).toBeVisible();
  await expect(list.getByRole("link", { name: "Learn" })).toBeHidden();
  await expect(list).toContainText("Coordinator: Project Manager");

  await page.goto(`/agents/${manager.id}`);
  const teamsSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Teams" }) });
  await expect(teamsSection).toContainText("Build");
  await expect(teamsSection).toContainText("Coordinator");

  // A deleted agent leaves its teams (and its coordinator role).
  await db.delete(agents).where(eq(agents.id, manager.id));
  await page.goto(`/teams/${build.id}`);
  await expect(page.getByText("No coordinator yet.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Project Manager" })).toHaveCount(0);
});

test("shows a disabled member as disabled, and says so when choosing delegation targets", async ({ page }) => {
  const { manager } = await trio();
  const idle = await createAgent({ name: "Idle Agent", enabled: false });
  const [team] = await db.insert(teams).values({ name: "Mixed" }).returning();
  await db.insert(teamMembers).values([
    { teamId: team.id, agentId: manager.id },
    { teamId: team.id, agentId: idle.id },
  ]);
  await page.goto(`/teams/${team.id}`);
  const idleRow = page.locator("section").filter({ has: page.getByRole("heading", { name: "Members" }) }).getByRole("listitem").filter({ hasText: "Idle Agent" });
  await expect(idleRow).toContainText("Disabled");
  await page.getByRole("button", { name: "Edit delegation for Project Manager" }).click();
  await expect(page.getByText("disabled: receives nothing until enabled")).toBeVisible();
});

for (const theme of ["Light", "Dark"] as const) {
  test(`team pages read well on a phone in the ${theme.toLowerCase()} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme: theme === "Dark" ? "dark" : "light" });
    const { manager, developer, researcher } = await trio();
    const [team] = await db
      .insert(teams)
      .values({ name: "Solas Development Team", description: "A team with a fairly long description that wraps on a phone." })
      .returning();
    await db.insert(teamMembers).values([
      { teamId: team.id, agentId: manager.id, role: "coordinator" },
      { teamId: team.id, agentId: developer.id },
      { teamId: team.id, agentId: researcher.id },
    ]);
    await db.insert(agentDelegationTargets).values({ agentId: manager.id, targetAgentId: developer.id });
    await createTask(developer.id, { title: "A task with a long title for the team page on a phone", teamId: team.id });

    for (const path of ["/teams", `/teams/${team.id}`, "/teams/new", `/teams/${team.id}/edit`]) {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme.toLowerCase());
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), path).toBe(true);
    }
  });
}
