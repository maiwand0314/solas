import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  agents,
  completeRun,
  conversations,
  createAgent,
  createConversation,
  db,
  messages,
  messagesOf,
  resetDatabase,
  runs,
  runsOf,
  streamInto,
} from "./database";

// Conversations in a real browser, against the production build. Each test
// sets up its own data; replies are written to the database the way the
// worker writes them, so no test ever calls Claude.

test.beforeEach(async () => {
  await resetDatabase();
});

/** The messages of the visible page (Next.js keeps the previous page mounted, hidden). */
const thread = (page: Page) => page.locator('ol[aria-label="Messages"]:visible');
const composer = (page: Page) => page.locator("textarea:visible");

test("lists conversations beside the open one and moves between them", async ({ page }) => {
  const agent = await createAgent();
  const alpha = await createConversation(agent.id, "Alpha planning", [
    { user: "Alpha question", assistant: "Alpha answer" },
  ]);
  await createConversation(agent.id, "Beta research", [{ user: "Beta question", assistant: "Beta answer" }]);

  await page.goto("/conversations");
  const nav = page.getByRole("navigation", { name: "Conversations" });
  await expect(nav.getByRole("link")).toHaveCount(2);

  await nav.getByRole("link", { name: /Alpha planning/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Alpha planning" })).toBeVisible();
  await expect(nav.getByRole("link", { name: /Alpha planning/ })).toHaveAttribute("aria-current", "page");
  await expect(thread(page)).toContainText("Alpha answer");
  await expect(thread(page)).not.toContainText("Beta");

  await nav.getByRole("link", { name: /Beta research/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Beta research" })).toBeVisible();
  await expect(thread(page)).toContainText("Beta answer");
  await expect(thread(page)).not.toContainText("Alpha");
  expect(page.url()).not.toContain(alpha.id);
});

test("keeps the conversation, and a reply in progress, across a reload", async ({ page }) => {
  const agent = await createAgent();
  const conversation = await createConversation(agent.id, "Saved chat", [
    { user: "First question", assistant: "First answer" },
    { user: "Second question", run: { status: "running", startedAt: new Date(), partialOutput: "Half of the" } },
  ]);

  await page.goto(`/conversations/${conversation.id}`);
  await expect(thread(page)).toContainText("First answer");
  await expect(thread(page)).toContainText("Half of the");
  await page.reload();
  await expect(thread(page)).toContainText("First answer");
  await expect(thread(page)).toContainText("Half of the");
  await expect(page.getByRole("status").filter({ hasText: "Research Assistant is writing" })).toBeVisible();
});

test("shows reply text as the worker saves it, then the saved reply", async ({ page }) => {
  const agent = await createAgent();
  const conversation = await createConversation(agent.id, "Streaming", [
    { user: "Explain streaming", run: { status: "running", startedAt: new Date(), partialOutput: "Streaming means" } },
  ]);
  const [run] = await runsOf(conversation.id);

  await page.goto(`/conversations/${conversation.id}`);
  await expect(thread(page)).toContainText("Streaming means");

  await db.update(runs).set({ partialOutput: "Streaming means sending text as it is written" }).where(eq(runs.id, run.id));
  await expect(thread(page)).toContainText("as it is written");

  // The worker finishes: the reply becomes a message and the run completes.
  await db.transaction(async (tx) => {
    await tx.insert(messages).values({
      conversationId: conversation.id,
      role: "assistant",
      content: "Streaming means sending text as it is written.",
      runId: run.id,
    });
    await tx.update(runs).set({ status: "completed", partialOutput: null }).where(eq(runs.id, run.id));
  });
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(thread(page)).toContainText("Streaming means sending text as it is written.");
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  // Regression (M3B): the streamed text and the saved reply must not both show.
  await expect(thread(page).getByText("Streaming means sending text as it is written")).toHaveCount(1);
  await page.waitForTimeout(1500); // a few more polls and refreshes
  await expect(thread(page).getByText("Streaming means sending text as it is written")).toHaveCount(1);
});

test("opens at the newest message, and stops following when the owner scrolls up to read", async ({ page }) => {
  const agent = await createAgent();
  const long = "A long earlier answer. ".repeat(80);
  const conversation = await createConversation(agent.id, "Long chat", [
    { user: "First", assistant: long },
    { user: "Second", assistant: long },
    { user: "Third", run: { status: "running", startedAt: new Date(), partialOutput: "The newest words" } },
  ]);

  await page.goto(`/conversations/${conversation.id}`);
  await expect(page.getByText("The newest words")).toBeInViewport();
  await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);

  await page.mouse.wheel(0, -2000);
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  // New text arrives while reading further up: the page doesn't move.
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await db.update(runs).set({ partialOutput: "The newest words, and more" }).where(eq(runs.conversationId, conversation.id));
  await expect(page.getByText("The newest words, and more")).toBeAttached();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);

  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect(page.getByText("The newest words, and more")).toBeInViewport();
});

test.describe("no duplicate messages (regression, M3B)", () => {
  /**
   * Elements whose whole text is `text`: a reply paragraph, or a message bubble
   * (which starts with "You: " for screen readers).
   */
  const occurrences = (page: Page, text: string) =>
    thread(page).getByText(new RegExp(`^(You: )?${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));

  test("each turn of a streamed conversation shows its question and reply exactly once", async ({ page }) => {
    const agent = await createAgent();
    await page.goto(`/conversations/new?agent=${agent.id}`);

    for (const [index, question] of ["My name is Alex.", "What is my name?"].entries()) {
      await composer(page).fill(question);
      await composer(page).press("Enter");
      if (index === 0) await page.waitForURL(/\/conversations\/[0-9a-f-]{36}$/);
      const conversationId = page.url().split("/").pop()!;
      // Wait until the send has been saved: one run per question so far.
      await expect.poll(async () => (await runsOf(conversationId)).length).toBe(index + 1);
      const run = (await runsOf(conversationId)).at(-1)!;
      await streamInto(run.id, `Answer ${index + 1}`);
      await expect(thread(page)).toContainText(`Answer ${index + 1}`);
      await completeRun(run.id, `Answer ${index + 1}.`);
      await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
      await page.waitForTimeout(1200); // further polls and refreshes must not add a copy
      await expect(occurrences(page, question)).toHaveCount(1);
      await expect(occurrences(page, `Answer ${index + 1}.`)).toHaveCount(1);
      await expect(thread(page).getByText(`Answer ${index + 1}`, { exact: true })).toHaveCount(0); // the draft is gone
    }

    const conversationId = page.url().split("/").pop()!;
    expect((await messagesOf(conversationId)).map((message) => message.content)).toEqual([
      "My name is Alex.",
      "Answer 1.",
      "What is my name?",
      "Answer 2.",
    ]);
  });

  test("a reload after a reply shows every message once", async ({ page }) => {
    const agent = await createAgent();
    const conversation = await createConversation(agent.id, "Reload", [
      { user: "Question one", assistant: "Reply one" },
      { user: "Question two", assistant: "Reply two" },
    ]);
    await page.goto(`/conversations/${conversation.id}`);
    for (let reload = 0; reload < 3; reload++) {
      await page.reload();
      for (const text of ["Question one", "Reply one", "Question two", "Reply two"]) {
        await expect(occurrences(page, text)).toHaveCount(1);
      }
    }
  });

  test("a retried reply is shown once, with the question once", async ({ page }) => {
    const agent = await createAgent();
    const conversation = await createConversation(agent.id, "Retry once", [
      { user: "Try me", run: { status: "failed", errorMessage: "Claude is overloaded." } },
    ]);
    await page.goto(`/conversations/${conversation.id}`);
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Waiting for the worker" })).toBeVisible();

    const retry = (await runsOf(conversation.id)).at(-1)!;
    await streamInto(retry.id, "Second attempt");
    await completeRun(retry.id, "Second attempt worked.");
    await expect(occurrences(page, "Second attempt worked.")).toHaveCount(1);
    await page.waitForTimeout(1200);
    await expect(occurrences(page, "Second attempt worked.")).toHaveCount(1);
    await expect(occurrences(page, "Try me")).toHaveCount(1);
    await expect(page.getByText("Claude is overloaded.")).toHaveCount(0); // the latest run counts
  });
});

test("renders Markdown safely, with copyable code", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const agent = await createAgent();
  const reply = [
    "# Overview",
    "Use **Drizzle** with `postgres`.",
    "",
    "- typed queries",
    "- migrations",
    "",
    "| Library | Type |",
    "| --- | --- |",
    "| Drizzle | ORM |",
    "",
    "```ts",
    "const db = drizzle(client);",
    "```",
    "",
    "<b>raw html</b> ![tracker](https://example.com/pixel.png)",
  ].join("\n");
  const conversation = await createConversation(agent.id, "Markdown", [{ user: "Show me", assistant: reply }]);

  await page.goto(`/conversations/${conversation.id}`);
  const view = thread(page);
  await expect(view.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(view.locator("strong", { hasText: "Drizzle" })).toBeVisible();
  await expect(view.locator("ul > li", { hasText: "typed queries" })).toBeVisible();
  await expect(view.getByRole("cell", { name: "ORM" })).toBeVisible();
  // Raw HTML stays text, and images aren't loaded.
  await expect(view).toContainText("<b>raw html</b>");
  await expect(view.locator("img")).toHaveCount(0);

  await view.getByRole("button", { name: "Copy code" }).click();
  await expect(view.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("const db = drizzle(client);");
});

test("renames a conversation using only the keyboard", async ({ page }) => {
  const agent = await createAgent();
  const conversation = await createConversation(agent.id, "Old title", [{ user: "Hi", assistant: "Hello" }]);

  await page.goto(`/conversations/${conversation.id}`);
  await page.getByRole("button", { name: "Conversation actions" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Rename…" })).toBeFocused();
  await page.keyboard.press("Enter");

  const title = page.getByRole("textbox", { name: "Title" });
  await expect(title).toBeFocused();
  await title.fill("Database choices");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { level: 1, name: "Database choices" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Conversations" })).toContainText("Database choices");
  const [row] = await db.select().from(conversations).where(eq(conversations.id, conversation.id));
  expect(row.title).toBe("Database choices");
});

test("deletes a conversation only after confirmation", async ({ page }) => {
  const agent = await createAgent();
  const conversation = await createConversation(agent.id, "Temporary", [{ user: "Hi", assistant: "Hello" }]);

  await page.goto(`/conversations/${conversation.id}`);
  const openDelete = async () => {
    await page.getByRole("button", { name: "Conversation actions" }).click();
    await page.getByRole("menuitem", { name: "Delete…" }).click();
  };

  await openDelete();
  const dialog = page.getByRole("dialog", { name: "Delete “Temporary”?" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused(); // the safe choice
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await db.select().from(conversations)).toHaveLength(1);

  await openDelete();
  await dialog.getByRole("button", { name: "Delete conversation" }).click();
  await page.waitForURL(/\/conversations$/);
  await expect(page.getByRole("navigation", { name: "Conversations" })).not.toContainText("Temporary");
  expect(await db.select().from(conversations)).toHaveLength(0);
  expect(await db.select().from(agents)).toHaveLength(1); // the agent stays
});

test("saves a message once, even when it is submitted twice", async ({ page }) => {
  const agent = await createAgent();
  await page.goto(`/conversations/new?agent=${agent.id}`);

  await composer(page).fill("Which database library fits a Next.js project?");
  await composer(page).press("Enter");
  await composer(page).press("Enter");
  await page.waitForURL(/\/conversations\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("status").filter({ hasText: "Waiting for the worker" })).toBeVisible();
  // While a reply is pending, Stop replaces Send.
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  const conversationId = page.url().split("/").pop()!;
  expect(await messagesOf(conversationId)).toHaveLength(1);
  expect(await runsOf(conversationId)).toHaveLength(1);
});

test("shows a failed reply and retries it as a new run", async ({ page }) => {
  const agent = await createAgent();
  const conversation = await createConversation(agent.id, "Failure", [
    {
      user: "Hello?",
      run: { status: "failed", errorCode: "usage_limit", errorMessage: "You’ve reached your Claude usage limit." },
    },
  ]);

  await page.goto(`/conversations/${conversation.id}`);
  await expect(page.getByText("You’ve reached your Claude usage limit.")).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Waiting for the worker" })).toBeVisible();

  const all = await runsOf(conversation.id);
  expect(all.map((run) => run.status)).toEqual(["failed", "pending"]);
  expect(await messagesOf(conversation.id)).toHaveLength(1); // the message isn't duplicated
});

test("a disabled agent's conversation can be read but not continued", async ({ page }) => {
  const agent = await createAgent({ enabled: false });
  const conversation = await createConversation(agent.id, "Paused", [{ user: "Hi", assistant: "Hello" }]);

  await page.goto(`/conversations/${conversation.id}`);
  await expect(thread(page)).toContainText("Hello");
  await expect(page.getByText("Research Assistant can’t answer right now")).toBeVisible();
  await expect(composer(page)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open agent" })).toBeVisible();
});

test("keyboard: Shift+Enter adds a line, Enter sends, Escape stops", async ({ page }) => {
  const agent = await createAgent();
  const conversation = await createConversation(agent.id, "Keys", [{ user: "Hi", assistant: "Hello" }]);

  await page.goto(`/conversations/${conversation.id}`);
  await composer(page).click();
  await page.keyboard.type("Line one");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("Line two");
  await expect(composer(page)).toHaveValue("Line one\nLine two");

  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Waiting for the worker" })).toBeVisible();
  await composer(page).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("status").filter({ hasText: "Stopped. No reply was saved." })).toBeVisible();

  const [, latest] = await messagesOf(conversation.id).then((all) => all.slice(-2));
  expect(latest.content).toBe("Line one\nLine two");
  expect((await runsOf(conversation.id)).at(-1)?.status).toBe("cancelled");
});

for (const theme of ["Light", "Dark"] as const) {
  test(`reads well in the ${theme.toLowerCase()} theme`, async ({ page }) => {
    const agent = await createAgent();
    const conversation = await createConversation(agent.id, "Themes", [
      { user: "Question", assistant: "An answer with `code`." },
    ]);

    await page.goto(`/conversations/${conversation.id}`);
    await page.getByRole("radio", { name: theme }).first().check({ force: true });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme.toLowerCase());

    // The page background follows the theme, and the text stays readable on it.
    // The browser converts the colours (oklch, lab, …) to sRGB by painting them.
    const [background, text] = await page.evaluate(() => {
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
      return [
        toRgb(getComputedStyle(document.body).backgroundColor),
        toRgb(getComputedStyle(document.querySelector('ol[aria-label="Messages"]:not([hidden])')!).color),
      ];
    });
    expect(contrastRatio(background, text)).toBeGreaterThanOrEqual(4.5);
    expect(luminance(background) < 0.2).toBe(theme === "Dark");
  });
}

test("mobile: the list and the conversation are separate pages, without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const agent = await createAgent();
  await createConversation(agent.id, "Mobile chat", [{ user: "Hi", assistant: "A fairly long reply ".repeat(20) }]);

  await page.goto("/conversations");
  await expect(page.getByRole("navigation", { name: "Conversations" })).toBeHidden();
  await page.getByRole("link", { name: /Mobile chat/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Mobile chat" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Conversations" }).first()).toBeVisible(); // back link
  await expect(composer(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

// --- Colour helpers for the theme test (WCAG relative luminance) ---------

function luminance([r, g, b]: [number, number, number]): number {
  const linear = (channel: number) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}
