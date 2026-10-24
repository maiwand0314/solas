import { expect, test, type Page } from "@playwright/test";
import {
  createAgent,
  createConversation,
  createToolCall,
  db,
  agentToolPermissions,
  resetDatabase,
  runsOf,
  setTools,
  toolCallById,
} from "./database";
import { eq } from "drizzle-orm";

// Tools & permissions in a real browser. Tool calls are written to the
// database the way the worker records them; no worker runs, so nothing calls
// Claude and no tool actually executes here (the worker side is covered by
// the Vitest suites).

test.beforeEach(async () => {
  await resetDatabase();
});

const thread = (page: Page) => page.locator('ol[aria-label="Messages"]:visible');

/** A conversation whose latest run is running, with one tool call recorded. */
async function runningWithCall(overrides: Parameters<typeof createToolCall>[1] = {}) {
  const agent = await createAgent();
  const conversation = await createConversation(agent.id, "Files", [
    { user: "Summarize my plan", run: { status: "running", startedAt: new Date(), heartbeatAt: new Date() } },
  ]);
  const [run] = await runsOf(conversation.id);
  const call = await createToolCall(run.id, overrides);
  return { agent, conversation, run, call };
}

test("Agent Builder: tools start off, can be enabled with 'Ask me first', and show on the agent page", async ({ page }) => {
  const agent = await createAgent();
  await page.goto(`/agents/${agent.id}`);
  await expect(page.getByText("No tools. This agent can only reply with text.")).toBeVisible();

  await page.getByRole("link", { name: "Edit" }).click();
  const readSwitch = page.getByRole("switch", { name: "Read workspace file" });
  await expect(readSwitch).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("switch", { name: "Current date and time" })).toHaveAttribute("aria-checked", "false");

  // Keyboard: focus the switch, toggle with Space.
  await readSwitch.focus();
  await page.keyboard.press("Space");
  await expect(readSwitch).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("~/Solas/workspaces/" + agent.id, { exact: false })).toBeVisible();
  await page.getByLabel("When the agent uses it").selectOption("ask");
  await page.getByRole("switch", { name: "Current date and time" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();

  await page.waitForURL(`/agents/${agent.id}`);
  const tools = page.getByRole("region").or(page.locator("section")).filter({ hasText: "Checked by Solas on every call." });
  await expect(tools).toContainText("Current date and time");
  await expect(tools).toContainText("Read workspace file");
  await expect(tools).toContainText("Asks you first");
  const saved = await db.select().from(agentToolPermissions).where(eq(agentToolPermissions.agentId, agent.id));
  expect(saved.map(({ toolId, mode }) => ({ toolId, mode })).sort((a, b) => a.toolId.localeCompare(b.toolId))).toEqual([
    { toolId: "current_time", mode: "allow" },
    { toolId: "read_workspace_file", mode: "ask" },
  ]);

  // Turning a tool off removes its permission.
  await page.getByRole("link", { name: "Edit" }).click();
  await page.getByRole("switch", { name: "Read workspace file" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(`/agents/${agent.id}`);
  const after = await db.select().from(agentToolPermissions).where(eq(agentToolPermissions.agentId, agent.id));
  expect(after.map((row) => row.toolId)).toEqual(["current_time"]);
});

test("an approval request shows the exact input, and Approve records the decision", async ({ page }) => {
  const { conversation, call } = await runningWithCall();
  await page.goto(`/conversations/${conversation.id}`);

  const card = page.getByRole("region", { name: "Approval needed: Read workspace file" });
  await expect(card).toBeVisible();
  await expect(card.locator("pre")).toContainText('"path": "notes/plan.md"');
  await expect(card).toContainText(/Expires in [0-9]:[0-5][0-9]/);
  await expect(page.getByRole("status").filter({ hasText: "Waiting for your approval" })).toBeVisible();

  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card.getByRole("button", { name: "Approved" })).toBeDisabled();
  const decided = await toolCallById(call.id);
  expect(decided.status).toBe("approved");
  expect(decided.decidedAt).not.toBeNull();
});

test("Reject records the rejection, and the action is never marked to run", async ({ page }) => {
  const { conversation, call } = await runningWithCall();
  await page.goto(`/conversations/${conversation.id}`);
  const card = page.getByRole("region", { name: "Approval needed: Read workspace file" });
  await card.getByRole("button", { name: "Reject" }).click();
  await expect(card.getByRole("button", { name: "Rejected" })).toBeDisabled();
  expect((await toolCallById(call.id)).status).toBe("rejected");
});

test("an expired request can't be approved", async ({ page }) => {
  const { conversation, call } = await runningWithCall({ approvalExpiresAt: new Date(Date.now() - 1_000) });
  await page.goto(`/conversations/${conversation.id}`);
  const card = page.getByRole("region", { name: "Approval needed: Read workspace file" });
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card.getByRole("alert")).toContainText("expired");
  expect((await toolCallById(call.id)).status).toBe("awaiting_approval"); // unchanged: the worker marks it expired
});

test("a finished reply shows the tools it used, folded away", async ({ page }) => {
  const agent = await createAgent();
  await setTools(agent.id, [{ toolId: "read_workspace_file", mode: "allow" }]);
  const conversation = await createConversation(agent.id, "Done", [{ user: "Read my plan", assistant: "Your plan is short." }]);
  const [run] = await runsOf(conversation.id);
  await createToolCall(run.id, {
    status: "succeeded",
    requiresApproval: false,
    approvalExpiresAt: null,
    resultSummary: "notes/plan.md (0.1 KB)",
  });
  await createToolCall(run.id, {
    input: { path: "../secret.txt" },
    inputSummary: "../secret.txt",
    status: "failed",
    requiresApproval: false,
    approvalExpiresAt: null,
    errorMessage: "That path is outside the workspace.",
  });

  await page.goto(`/conversations/${conversation.id}`);
  const summary = thread(page).getByText("Used 2 tools");
  await expect(summary).toBeVisible();
  await expect(thread(page).getByText("notes/plan.md (0.1 KB)")).toBeHidden();
  await summary.click();
  await expect(thread(page).getByText("notes/plan.md (0.1 KB)")).toBeVisible();
  await expect(thread(page).getByText("That path is outside the workspace.")).toBeVisible();
  await expect(thread(page).getByText("Failed")).toBeVisible();
});

for (const theme of ["Light", "Dark"] as const) {
  test(`the approval card works on a phone in the ${theme.toLowerCase()} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { conversation } = await runningWithCall({
      input: { path: "a/very/long/folder/name/that/keeps/going/and/going/report-final-v2.md" },
      inputSummary: "a/very/long/folder/name/that/keeps/going/and/going/report-final-v2.md",
    });
    // The theme follows the system by default; emulate the phone's setting.
    await page.emulateMedia({ colorScheme: theme === "Dark" ? "dark" : "light" });
    await page.goto(`/conversations/${conversation.id}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme.toLowerCase());

    const card = page.getByRole("region", { name: "Approval needed: Read workspace file" });
    await expect(card.getByRole("button", { name: "Approve" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
