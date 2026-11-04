# Solas — Learning Log

A running record of what was built, what was learned, and what to practise.
One entry per milestone. Rewrite explanations in your own words when you can;
that is where the learning sticks.

## Entry template

```md
## M<n> — <title> (<date>)

**Built:** one or two sentences.

**Concepts**
- Concept — one-line explanation.

**Files changed**
- `path` — responsibility.

**How it was verified**
- Checks run, what was observed.

**Exercise**
- The task, and what I found.

**Questions to revisit**
- …
```

---

## M0 — Documentation and architecture (2026-10-23)

**Built:** The project documentation, the MVP definition, the milestone
roadmap, and a decision on how agents reach Claude. No application code
changed.

**Concepts**
- **Two processes, one database.** The web app (Next.js) handles pages and
  requests. A separate worker process runs agents. They communicate only by
  reading and writing PostgreSQL, so either can restart without breaking the
  other, and agent work survives the browser closing.
- **A queue can be a table.** A `runs` table with a status column, claimed
  with `SELECT … FOR UPDATE SKIP LOCKED`, is enough for one owner. No separate
  queue service is needed.
- **Adapter pattern.** The worker calls an `AgentRuntime` interface, and each
  model provider gets an adapter that turns its output into Solas's own event
  format. Changing provider means writing one new adapter.
- **Claude Agent SDK vs. Claude API.** The Agent SDK runs the Claude Code
  binary: the full agent loop with built-in tools, permissions, hooks, and
  sessions. The Client SDK (API) is a direct model call where you write the
  loop yourself. The Agent SDK can use the machine's Claude Code login. The
  Client SDK needs an API key.
- **Subscription vs. API key: what the terms say.** Team plans are covered by
  Anthropic's Commercial Terms. An owner may sign in to the unmodified Claude
  Code binary with their own subscription. Developers building products or
  services for others must use API keys and may never offer claude.ai login
  or handle claude.ai credentials. Solas is single-owner, so the subscription
  is reasonable for the local prototype, but not something to assume for
  hosted use.
- **Least privilege for agents.** Agents start with no tools. Anything powerful
  is added deliberately, scoped to a workspace directory, checked by a policy
  hook, and gated by approval when sensitive.
- **This Next.js version (16.4).** Middleware is now Proxy. Cache Components
  are on. Version-matched docs live in `node_modules/next/dist/docs/`.

**Files changed**
- `CLAUDE.md` — rules for Claude Code in this repo (imports `AGENTS.md`).
- `PROJECT_PLAN.md` — vision, runtime decision, MVP, milestones, open decisions.
- `ARCHITECTURE.md` — components, data model, runtime layer, flows, security.
- `DESIGN_SYSTEM.md` — tokens, type, layout, components, accessibility.
- `LEARNING_LOG.md` — this file.

**How it was verified**
- `npm run lint`, `npx tsc --noEmit`, and `npm run build` pass on the
  untouched starter app. `next start` serves `/` with HTTP 200.
- `claude auth status` shows Claude Code 2.1.309 signed in with a claude.ai
  account on a Team subscription. No credential values were read.
- Anthropic docs checked: Agent SDK overview, Legal and compliance,
  Authentication, Agent SDK quickstart, Agent SDK permissions.

**Exercise**
- Read `ARCHITECTURE.md` §6.1 (sending a message). Close it and draw the flow
  from memory on paper: which process writes which table, and in what order.
  Then answer here: *why does closing the browser not stop the agent's run?*

**Questions to revisit**
- Should conversation continuity replay stored history or resume SDK
  sessions? (Decide in M5.)
- How should an approval survive a worker restart? (After M7.)

---

## M1 — Design system and application foundation (2026-10-23)

**Built:** The Solas shell. It has a collapsible sidebar, a top bar with
breadcrumbs and search, a mobile drawer, and a ⌘K command menu. Six pages have
honest empty states, a loading skeleton covers slow pages, and light/dark/system
themes persist without a flash. No new dependencies.

**Concepts**
- **Design tokens.** `globals.css` defines semantic colors once per theme.
  `@theme inline` turns them into utilities (`bg-surface`, `text-muted`).
  Switching theme only changes variable values.
- **Flash before hydration.** The theme lives in `localStorage`, which the
  server can't see. A tiny inline script in `<head>` sets `data-theme` before
  the first paint. `suppressHydrationWarning` on `<html>` tells React that
  this one difference is expected.
- **`useSyncExternalStore`.** Reads state that lives outside React (storage,
  `<html>` attributes). A separate server snapshot avoids hydration errors.
- **Native `<dialog>`.** `showModal()` provides focus handling, Escape, an inert
  background, and focus restore. The `Dialog` component only keeps the element
  in sync with React state.
- **ARIA combobox.** In the command menu, focus stays in the input.
  `aria-activedescendant` tells screen readers which option is highlighted
  while the arrow keys move it.
- **Server vs. Client Components.** `Sidebar` and `TopBar` are Server
  Components. Only the leaves that need the URL, state, or events are client
  code.
- **`loading.tsx`.** Next.js wraps each page in Suspense with this fallback.
  It matters once pages read from the database.

**Files changed**
- `src/app/globals.css` and `layout.tsx`: tokens, base styles, pre-paint script.
- `src/app/(app)/`: shell layout, loading state, six pages.
- `src/app/not-found.tsx`: 404.
- `src/components/ui/`: Button/IconButton, Input, Dialog, Badge, Kbd, Skeleton,
  PageHeader, EmptyState.
- `src/components/shell/`: sidebar, nav, top bar, breadcrumbs, mobile nav,
  command menu, wordmark.
- `src/components/preferences/`: theme and sidebar stores, watcher, selectors.
- `src/lib/`: preferences (keys and inline script), `cn`, keyboard helper.

**How it was verified**
- ESLint, `tsc --noEmit`, and `next build` pass. All 7 routes are prerendered.
- Scripted headless Chrome QA, 26 checks:
  - theme resolution and persistence across reloads;
  - ⌘K open, filter, Enter, and Escape; `[` toggle;
  - drawer open, close, and focus return;
  - no horizontal scroll at 375px on every page;
  - no console errors.
- Screenshots reviewed in both themes at desktop and phone width.

**Exercise**
- Add a "Go to Settings → Appearance" command to the command menu that
  navigates to `/settings#appearance`. You'll need an `id` on the Appearance
  section and a new entry in the `commands` list. Then check that the page
  scrolls to the section, and that the "Current" hint still makes sense.

**Questions to revisit**
- Pages with dynamic segments (e.g. `/agents/[id]`) will need `<Suspense>`
  around components that call `usePathname`, because Cache Components are on.
  (M2)

---

## M2A — Agent data architecture and backend (2026-10-23)

**Built:** Agents are now data. Their configuration lives in a PostgreSQL
table behind a validated, tested service layer. No UI and no AI execution
yet; every agent is honestly "not configured" because no execution provider
exists.

**Concepts**
- **Docker Compose.** `compose.yaml` describes a container: image, port, and a
  named volume for data. The volume outlives the container, so
  `npm run db:down` keeps data and `db:reset` (`down -v`) deletes it.
- **Schema as code + migrations.** You edit `schema.ts`, drizzle-kit writes
  the SQL difference into `drizzle/`, and `db:migrate` applies it once and
  records it. Every machine gets the same database by replaying the same files.
- **Defense in depth.** Zod checks input in the app. A unique index and check
  constraints check it again in the database. Both must be bypassed for bad
  data to get in.
- **Stable codes, friendly messages.** The service throws one error type with
  a fixed `code` for programs and a `message` for people. Raw database errors
  are logged, never shown.
- **Dependency injection.** `createAgentService({ db, providers })` takes its
  dependencies as arguments. Tests pass a test database and a fake registry,
  and the app passes the real ones.
- **Configuration vs. capability.** An agent stores which provider/model it
  wants. A separate registry says what actually works. Readiness is computed,
  never stored, so it can't go stale.
- **Fail closed.** Without sign-in, mutations are refused unless local owner
  mode is on *and* the request came to `localhost`.
- **Server Actions vs. API routes.** Actions get origin checks and exist only
  when imported, so none are reachable yet. A JSON API route would be open to
  any website you visit, through your browser.
- **ESM vs. CommonJS.** Top-level `await` needs an ES module. Without
  `"type": "module"` in `package.json`, `.mts` files are ES modules.

**Files changed**
- New: `compose.yaml`, `.env.example`, `drizzle.config.ts`, `drizzle/`
  (migration), `vitest.config.mts`, `scripts/agents.mts`.
- New in `src/server/`:
  - `db/`: schema, client, errors.
  - `agents/`: service, validation, errors.
  - `providers/registry.ts`.
  - `auth/owner.ts`.
  - `actions/result.ts`.
  - Tests next to each.
- New: `src/test/global-setup.ts`, `src/app/(app)/agents/actions.ts`.
- Modified:
  - `package.json`: scripts and dependencies; dev/start now bind to 127.0.0.1.
  - `.gitignore`: allow `.env.example`.
  - `CLAUDE.md`, `PROJECT_PLAN.md`, `ARCHITECTURE.md`.
- Local only: `.env.local`, with a generated password; git-ignored.

**How it was verified**
- 53 Vitest tests pass:
  - connection;
  - create, read, update, delete, enable/disable;
  - invalid input, malformed and unknown ids, case-insensitive duplicate names;
  - provider rules and the database constraint;
  - persistence across a new connection pool;
  - an unreachable database;
  - host checks and action error mapping.
- CLI against the dev database:
  - full CRUD;
  - each invalid case;
  - the agent survives `db:down` / `db:up`;
  - a clear error while the database is down.
- `typecheck`, `lint`, and `build` pass.
- The build registers 0 Server Actions. No password or connection string is in
  the client bundle.
- The app serves all pages and listens only on 127.0.0.1.

**Exercise**
- Add an optional `avatarColor` field to agents, limited to a small set of
  token names such as `"neutral"` or `"accent"`:
  1. Edit `schema.ts`.
  2. Run `npm run db:generate` and read the SQL it wrote.
  3. Run `npm run db:migrate`.
  4. Add the field to both Zod schemas with `z.enum([...])`.
  5. Add one test that rejects an unknown color.
- Watch which layer catches what.

**Questions to revisit**
- Delete vs. archive once conversations reference agents (M5).
- Should reads in Server Components also go through a guarded helper, so no
  page can forget `requireOwner()`? (M2B)

## M2B — Agent Builder UI (2026-10-24)

**Built:** You can now manage agents in the browser: list and search, create,
view, edit, enable/disable, duplicate, and delete. Agents still can't run;
every page says so honestly instead of offering a model picker that doesn't
work.

**Concepts**
- **One set of rules, run twice.** The Zod schemas moved to
  `src/lib/agents/validation.ts` so the browser can use them too. The form
  checks input instantly; the server checks it again, because anything the
  browser sends can be forged. Both return errors in the same shape, so the
  form shows them the same way.
- **Server Actions from client code.** The form calls `createAgent(input)` like
  a normal async function. Next.js turns that into a POST to the server. The
  action returns `{ ok, data }` or `{ ok, error }` instead of throwing, so a
  failure becomes a message next to a field, not a crash.
- **Why not `useActionState`.** It's built for forms that post `FormData`
  and re-render from the server's answer. This form validates first, sends a
  typed object, and on edit sends only the fields that changed. A plain
  `useTransition` around the action call was simpler and gives the same
  `pending` flag.
- **Optimistic UI.** The enable switch uses `useOptimistic`: it moves at once,
  and React puts it back by itself if the save fails.
- **Suspense under Cache Components.** Anything read per request (the agent
  list, an agent from the URL, even `usePathname()` on a dynamic route) must
  sit inside `<Suspense>`. The static frame is sent first, and the data
  streams in after.
- **Revalidation.** After a change, `revalidatePath("/agents", "layout")`
  marks the list and every agent page as stale. Delete refreshes only the
  list, so the deleted agent's page doesn't flash "not found".
- **Hidden, not unmounted.** Next.js keeps visited pages mounted but hidden.
  The form and dialog reset in a layout-effect cleanup. Otherwise they come
  back with an old draft, or with a modal still open.
- **Accessible errors.** Each error is linked to its input with
  `aria-describedby`, and the input gets `aria-invalid`. Focus moves to the
  first invalid field. The delete dialog opens with Cancel focused.
- **Guarded reads.** Pages import `listAgentsForOwner()` and
  `getAgentForOwner()`, never the raw service. Each of them calls
  `requireOwner()` first, so no page can forget the check. This answers the
  M2A question.
- **Not-found status after streaming.** `notFound()` inside Suspense shows the
  not-found page, but the HTTP status is 200. The headers were already sent
  when streaming began. That's fine for a private app; search engines get a
  `noindex` tag.

**Files changed**
- New pages in `src/app/(app)/agents/`:
  - `new/`;
  - `[agentId]/` (details, `edit/`, not-found, `load-agent.ts`);
  - `error.tsx`.
- Changed in `src/app/(app)/agents/`:
  - `page.tsx`: list in Suspense;
  - `actions.ts`: `duplicateAgent`, and scoped revalidation.
- New: `src/components/agents/`:
  - list, details, form, actions menu, delete dialog, enabled switch,
    skeletons, and load error;
  - the hooks `use-agent-commands` and `use-unsaved-changes`.
- New UI primitives in `src/components/ui/`: Field, Textarea, Select, Switch,
  Menu, Callout, Toast, and RelativeTime.
- Changed primitives:
  - Button: danger variants;
  - Input: `aria-invalid` styling;
  - Dialog: closes when its page is hidden;
  - PageHeader: a badge slot.
- Shell:
  - breadcrumbs go deeper ("Agents / Details / Edit");
  - the ⌘K menu gets "New agent";
  - sidebar, breadcrumbs, and menu read the path inside Suspense;
  - the `Toaster` is in the layout;
  - a `--danger-foreground` token.
- Server:
  - validation moved to `src/lib/agents/`;
  - name, role, and instructions are required;
  - `service.duplicate()` was added;
  - `queries.ts` was added;
  - `describeModelSelection()` was added to the registry;
  - the CLI gets `duplicate`.
- Docs: `ARCHITECTURE.md` (validation path) and `PROJECT_PLAN.md`.

**How it was verified**
- `lint`, `typecheck`, and `build` pass. All 61 Vitest tests pass, including
  new tests for duplicate, for required fields, and for the form error shape.
- The build registers exactly five Server Actions: create, update,
  setEnabled, duplicate, and delete. The client bundle has no connection
  string, password, or Drizzle code.
- A Playwright script in the browser, against the production build. The script
  isn't in the repo; Playwright is not a project dependency.
  - An empty submit shows three field errors, focuses Name, and sets
    `aria-invalid`.
  - Create opens the details page.
  - A duplicate name (other case) shows the server's error on Name.
  - The enable switch saves and survives a reload.
  - Edit is disabled until something changes, and saves.
  - Duplicate makes a disabled "(copy)".
  - Search filters the list.
  - The delete dialog opens on Cancel, Escape closes it, and confirm deletes.
  - Delete from the details page returns to the list.
  - Deleted and malformed ids show not-found.
  - At 390 px wide there is no horizontal scroll.
  - No console errors. The test agents were removed afterwards.
- With the database stopped, the list shows "Can't load agents" with a retry
  button. It recovers after `db:up`.

**Exercise**
- Add a "Disable all" button to the Agents page header:
  1. Write a `setAllEnabled(false)` service method, with a test.
  2. Add a Server Action that calls it.
  3. Add a client button with a confirmation dialog.
- Decide which revalidation scope it needs, and why.

**Questions to revisit**
- Should search move to the database once there are many agents? (Not
  before it's needed.)
- When conversations reference agents (M5), does delete become archive?
- Playwright as a real dev dependency for key flows. The plan says "later";
  M4/M5 (live runs) is probably when it pays off.

## M3A — First working agent engine (2026-10-24)

**Built:** Agents can now answer. Pick an agent, write a message, and a
genuine Claude reply comes back, using that agent's stored instructions and
model. The reply is saved in PostgreSQL. A separate worker process does the
AI work; the web app never calls Claude. It runs on the owner's Claude Team
login through the official Agent SDK, locally only. No API key, no API
credits.

**Concepts**
- **Agent Engine.** The part of Solas that turns "this agent + this message"
  into a reply. Here it is three layers:
  - the executor (`runs/executor.ts`) claims a run and records the outcome;
  - the runtime interface (`runtime/types.ts`) is the one way to ask a
    provider for an answer;
  - the Claude adapter (`runtime/claude-agent-sdk.ts`) speaks the SDK.
- **Agents are data.** The worker loads the agent row by ID when the run
  starts, and loads it fresh: if you disable it in between, it won't run.
  Nothing in the code knows "Research Assistant"; any agent you create works.
- **Provider interface.** `AgentRuntime.run(input, signal)` returns
  completed / failed / aborted and never throws. The executor only knows
  this. Another provider (an API-key adapter, say) is one new file plus a
  registry entry.
- **How instructions reach Claude.** `systemPrompt: agent.instructions`, as
  a plain string. A string *replaces* Claude Code's own system prompt, so the
  agent is exactly what you wrote. In the smoke test, the reply followed the
  agent's own rule "Cite every claim."
- **From message to run.**
  1. The Server Action validates the message.
  2. It checks the agent: enabled, and a model the registry offers.
  3. In one transaction it saves the message and a `pending` run.
  4. The worker claims the run, builds the prompt (recent history + the new
     message), and calls the runtime.
  5. It saves the reply and marks the run `completed`.
- **Back to the browser.** The page polls the run's real status every second
  ("Waiting for the worker…", "… is responding · 0:12"). When the run is
  finished, the page asks the server to render again, and the reply comes
  from the database. Nothing is faked: no typing effect, no invented
  progress.
- **Errors and usage limits.** Claude Code reports problems as codes:
  - `authentication_failed`, `rate_limit`, `model_not_found`, …;
  - a `rate_limit_event` that is `rejected`, or that shows paid extra usage.

  The adapter maps each one to a Solas code and writes its own message, such
  as "Run `claude auth login`". Provider text never reaches the UI. It goes
  to the worker log, shortened.
- **Permissions, enforced twice.**
  1. *Ask for nothing:*
     - `tools: []`;
     - `permissionMode: "dontAsk"`;
     - a hook that denies every tool;
     - no settings files, no MCP servers;
     - an allowlisted environment, so no `DATABASE_URL` and no API keys;
     - an empty working directory outside the repo.
  2. *Check what you got:* the session's first message must say no API key,
     zero tools, zero MCP servers, `dontAsk`, and the requested model.
     Otherwise the run stops. Settings can come from places Solas doesn't
     control, so it verifies the result.
- **Why `dontAsk` must be explicit.** The SDK's types say an omitted
  `permissionMode` can start in `auto`, where a classifier approves actions.
  A default is not a decision.
- **Credential precedence.** An `ANTHROPIC_API_KEY` in the environment beats
  the subscription login, which would quietly switch to paid API billing.
  The allowlisted environment removes it, and the `apiKeySource: "none"`
  check catches anything else.
- **The queue is a table.** `runs.status` is the queue. Two safeguards:
  - `FOR UPDATE SKIP LOCKED` lets the worker claim a run safely;
  - a partial unique index (one pending/running run per conversation) makes
    a double click harmless at the database level.
- **`IN` vs `=` with a subquery (found by a test).** The first claim query
  was `id IN (SELECT … LIMIT 1 FOR UPDATE SKIP LOCKED)`. PostgreSQL planned
  it as a nested-loop semi-join and re-ran the subquery for each row, so
  "LIMIT 1" didn't hold and one claim marked *two* runs running. With `=`,
  the subquery becomes an InitPlan that runs once. `EXPLAIN` showed both
  plans. Lesson: SQL says *what*, the planner decides *how*; check the plan
  when it matters.
- **Next.js keeps pages mounted.** After navigating, the previous page stays
  in the DOM, hidden. My browser test first counted elements from both
  pages and reported a reply too early. The database and worker log showed
  the truth. Lesson: verify outcomes at the source, not only through the UI.

**Files changed**
- New:
  - `src/server/runtime/` (types, Claude adapter, tests);
  - `src/server/runs/` (executor, prompt, config, tests, test helpers);
  - `src/server/conversations/` (service, queries, errors, tests);
  - `src/server/logger.ts`;
  - `src/worker/index.mts`;
  - `src/lib/conversations/validation.ts`.
- New UI:
  - `src/app/(app)/conversations/` (actions; pages `new/` and
    `[conversationId]/`; not-found; error);
  - `src/components/conversations/` (conversation view, list, agent picker).
- Database: `drizzle/0001_conversations_and_runs.sql`, which adds tables
  and changes nothing existing.
- Changed:
  - registry: Claude is available with three models;
  - agent pages: a Chat button and updated copy; deleting an agent now also
    deletes its conversations;
  - breadcrumbs;
  - `LoadError` and `RetryButton` moved to `src/components/` so both
    features use them;
  - `package.json`: the `worker` script and the SDK dependency;
  - docs.

**How it was verified**
- `lint`, `typecheck`, and `build` pass. All 109 Vitest tests pass, three
  times in a row. They use a fake runtime and a fake SDK, so no Claude usage
  is spent. Among them:
  - instructions and model are passed through;
  - disabled, missing, and unconfigured agents are refused;
  - invalid input is rejected;
  - unsupported models are refused;
  - sign-in failure, usage limit, paid overage, and budget are handled;
  - timeout, Stop, shutdown, and crash recovery work;
  - no secrets in errors or in the environment;
  - no tools are enabled;
  - a run is never claimed twice.
- The Agent SDK appears in neither the browser bundle nor the web server
  bundle. Exactly 8 Server Actions are registered.
- **One real smoke test** through the UI:
  - Agents → Research Assistant → Edit (Claude · Opus 5.5) → enable →
    Chat → the example question;
  - the worker log showed `apiKeySource: "none"`, `tools: 0`,
    `mcpServers: 0`, `permissionMode: "dontAsk"`, and
    `model: "claude-opus-5-5"`;
  - the run took 24 s and produced 2,532 output tokens; a 6,150-character
    reply was saved and shown, in light, dark, and at 390 px.
- UI states checked **without** Claude, with the worker stopped:
  - pending, then the "Is the worker running?" hint;
  - Stop on a pending run;
  - "responding" with a live timer (set in the database);
  - Esc → "Stopping";
  - a worker restart marks the stuck run failed, and the UI shows why.

**Exercise**
- Give the Research Assistant a second conversation and ask a follow-up that
  depends on the first answer. Then read `buildPrompt` in `runs/prompt.ts`
  and explain how the agent "remembers". Change `historyMessages` to 2 and
  see what it forgets.

**Questions to revisit**
- Is the Team seat (Xala organization) the right account for a personal
  project? Ask the org admin, or move to a personal plan or API key.
- Streaming (M3B): the SDK can send partial messages. Store them as
  `run_events` and stream over SSE?
- Markdown rendering: write a small safe renderer, or approve a dependency?
- Long conversations: replaying history costs tokens on every turn. Is SDK
  session resume worth writing transcripts into `~/.claude`?
- `input_tokens` from the SDK result was 2: it counts only uncached input.
  Track cache tokens too, if usage becomes interesting.

## M3B — Persistent conversations, context, and streaming (2026-10-24)

**Built:** Conversations are now a place to work. An agent can have many
of them. You can rename and delete them, and move between them from a list
beside the open conversation. Replies appear while Claude writes them,
rendered as Markdown. Everything survives a reload, a closed browser, and a
worker restart. Sending twice never stores a message twice.

**Concepts**
- **How persistence works.** Every message is a row in PostgreSQL the moment
  it is accepted. The page is only a view of those rows. Close the browser
  and nothing is lost: the next visit reads the same rows.
- **How messages are stored.**
  - User and assistant messages are rows in `messages`, ordered by time.
  - A reply is written only when it is complete. While Claude is still
    writing, the text lives on the run (`partial_output`), not in the
    conversation.
  - Each user message carries a `client_message_id` chosen by the browser.
- **How multi-turn context works.**
  - Each run is a fresh Claude session.
  - The worker rebuilds the conversation from the database: the last 20
    messages, at most 60,000 characters, oldest dropped first. It sends them
    before the new message.
  - So "this project" is understood: the earlier "My project uses Next.js
    and PostgreSQL" is in the prompt. The real test showed it. The second
    reply began "For a typical Next.js + PostgreSQL project (stack per your
    earlier message)…".
- **Why not the SDK's session resume?** It keeps the conversation in a file
  under `~/.claude`. Deleting a conversation in Solas wouldn't delete it,
  and context would depend on one machine's folder. One source of truth (the
  database) beats a second, hidden one. The cost: earlier turns are sent
  again each time, and very long conversations forget their beginning.
- **How instructions apply.** The agent row is read when each run starts.
  Edit the instructions, and the next message in *any* conversation, old or
  new, uses them. A reply already being written keeps the instructions it
  started with.
- **How the worker processes a conversation.**
  1. It claims the oldest pending run.
  2. It reloads the agent.
  3. It rebuilds the context and calls Claude.
  4. It saves the text every 300 ms while Claude writes.
  5. It refreshes a heartbeat every second; the same query checks for Stop.
  6. In one transaction, it saves the reply and marks the run completed.
- **What happens when you close the browser.** Nothing changes for the run:
  it belongs to the database and the worker. When you come back, the page
  shows the run as it is now: still writing (with the text so far), done,
  or failed.
- **What happens when the worker crashes.** The run's heartbeat stops.
  - After 30 s, any worker marks it `failed`: at start, and every 30 s while
    it runs. The owner sees "The worker stopped… use Retry".
  - It is **not** re-run automatically: Claude may already have done (and
    counted) the work, and Solas can't verify a result it never got.
  - Pending runs just wait and run when a worker is back.
- **Session isolation.**
  - Context comes only from the run's own conversation.
  - The agent is the conversation's agent. The server also refuses a message
    that claims a conversation belongs to a different agent.
  - Claude itself runs in a fresh, settings-free session each time, so
    nothing carries over between conversations except what Solas sends.
- **How duplicate executions are prevented.** Four layers:
  1. A client message ID: a repeated send returns the first result, even
     two identical sends arriving at the same moment.
  2. A partial unique index: one pending or running run per conversation.
  3. `FOR UPDATE SKIP LOCKED` with a scalar subquery: one worker per run.
  4. Recovery only touches runs whose heartbeat is stale, so a second worker
     never steals a live run.
- **Real streaming vs. fake streaming.** The SDK's `includePartialMessages`
  gives the actual text deltas from the API. Solas saves them and the page
  reads them. A typing animation over a finished answer would look the
  same, and be a lie.
- **Stick to bottom, politely.** The page follows new text only while you
  are reading the end. Scroll up and it stays put; "Jump to latest" brings
  you back. A real bug was found by screenshot: the end marker sat *above*
  the sticky composer, so "the end" was 140 px short. Moving it below fixed
  it, and a test now guards it.
- **Testing in layers.**
  - Vitest checks the logic with fake providers.
  - Playwright checks the real app in a real browser, with its own database
    and no worker.
  - One controlled real run proves the whole chain.

  Each layer catches what the others can't. Playwright found a real bug
  too: copied code carried a trailing line break.

**Files changed**
- Database: `drizzle/0002_streaming_heartbeat_idempotency.sql`. It adds
  three nullable columns and one unique index, and deletes nothing.
- Engine:
  - `runtime/types.ts` and `claude-agent-sdk.ts`: streaming;
  - `runs/executor.ts`: heartbeat, stale recovery, saving partial output;
  - `runs/config.ts`;
  - `conversations/service.ts`: idempotent send, agent check, retry, rename,
    delete;
  - `worker/index.mts`: periodic recovery.
- UI:
  - `conversations/layout.tsx`: two panes;
  - `conversation-view.tsx`;
  - new `markdown.tsx`, `conversation-nav.tsx`, `conversation-actions.tsx`;
  - `actions.ts`;
  - the pages.
- Tests:
  - expanded `executor.test.ts`, `service.test.ts`, and the adapter tests;
  - `e2e/` and `playwright.config.ts`;
  - shared `src/test/global-setup.ts`.
- `package.json`: three dependencies and `test:e2e`.
- Docs.

**How it was verified**
- `lint`, `typecheck`, and `build` pass.
- Vitest: 130 tests pass, three times in a row. They cover:
  - multi-turn context (the "this project" example);
  - isolation between conversations and between agents;
  - latest instructions;
  - streaming;
  - restart and recovery, and that a live worker's run is not stolen;
  - duplicates, including simultaneous ones;
  - retry, rename, delete, and deleting mid-run;
  - provider errors, timeouts, Stop, and disabled agents.
- Playwright: 14 tests pass, three times in a row. They cover:
  - navigation and reload, including a reply in progress;
  - streaming display and Markdown, with copying code;
  - keyboard-only rename, and delete with confirmation;
  - double submit, failure and Retry, and disabled agents;
  - composer keys and auto-scroll;
  - light and dark themes (contrast measured at ≥ 4.5:1);
  - mobile layout.
- One real two-turn conversation with Research Assistant (Opus 5.5) through
  the UI and worker:
  - turn 1 took 6.7 s and turn 2 took 12.4 s (worker log);
  - text visibly streamed in both turns;
  - reply 2 used the context from turn 1;
  - all 4 turns were there after a reload;
  - `apiKeySource: "none"`, `tools: 0`.
  My test script's own completion check was wrong and reported 240 s; the
  worker log has the real timings.

**Exercise**
- Open a conversation, ask something long, and close the tab while it is
  being written. Reopen it a minute later. What do you see, and which column
  (`partial_output` or `messages`) did it come from?
- Then stop the worker in the middle of a reply. How long until the UI says
  the worker stopped, and why that long?

**Questions to revisit**
- Long conversations forget their beginning. Add a stored summary of older
  turns, when it matters?
- Polling at 0.5 s is fine for one owner. Is SSE (or LISTEN/NOTIFY) worth it
  once tool calls need a live timeline?
- Should the worker refuse to start when another worker is already running,
  or is heartbeat safety enough?

## Fix — duplicate assistant replies in the UI (2026-10-24)

**Symptom:** after "My name is Alex…" and a follow-up, the correct reply
appeared twice in the conversation.

**Investigation, layer by layer**
- **Database:** that conversation had exactly 2 user messages and 2 replies.
  No run had more than one reply, and no message had more than one run.
  Nothing was saved twice.
- **Worker:** one run per message, one Claude session per run (worker log).
  Claude was not called twice, and no job was processed twice.
- **Browser:** reproduced without Claude in a Playwright test. The same reply
  text appeared **2** times on the page.

**Root cause** (in `conversation-view.tsx`, introduced in M3B):
- While a reply streams, the view remembers the latest text. When the run
  completes, it shows that text as a temporary "bridge", so nothing flickers
  away before the saved reply arrives from the server.
- The bridge was shown whenever "this run is completed". It didn't check
  whether the saved reply was already on the page.
- After `router.refresh()`, the page therefore showed both the saved reply
  and the bridge, until the next full reload.
- Two sources of truth for the same content, with no reconciliation by ID.

**The fix**
- **UI, by stable IDs:**
  - The bridge shows only while no saved message carries that run's `runId`.
  - The remembered text belongs to one run.
  - The optimistic "sending" message disappears when the saved message with
    the same `clientMessageId` is on the page.
- **Database, as the last word:** a partial unique index
  `messages_one_reply_per_run` (one assistant message per run). Even a
  future bug can't save a reply twice.
- **Worker, defensively:**
  - A run handed to the executor again is skipped without calling Claude:
    when it's already executing here, or no longer `running`.
  - The first version of that guard had a race of its own: it checked, then
    awaited the database, then marked. Two calls in the same tick both
    passed. A test caught it; the run is now marked before any `await`.
  - Saving a reply that the unique index refuses is logged as "already
    saved", not treated as a crash.

**What the regression tests protect**

| # | Requirement | Test |
| --- | --- | --- |
| 1, 2 | One message → one execution → one saved reply | Vitest: "one message gives one execution and one saved reply"; Playwright: each turn shown once |
| 3 | Duplicate event delivery | Vitest: the same run delivered again, or twice at once → executed once; Playwright: extra polls/refreshes add no copy |
| 4 | Browser refresh | Playwright: three reloads, every message once |
| 5 | Worker restart | Vitest: recovered run gets no reply; pending runs get exactly one |
| 6 | Retry | Vitest and Playwright: after a failure and Retry, exactly one reply |
| 7, 8 | Several turns; context | Vitest: three turns, each reply once, the history repeats nothing; Playwright: two streamed turns |
| 9 | Concurrent workers | Vitest: two workers race for one run → one execution, one reply |
| 10 | No duplicates in the database | Vitest: the database refuses a second reply for a run |

**The `solas-runtime` mention**
- Claude Code always adds an "Environment" section to the prompt: working
  directory, git status, platform. It does this even when the system prompt
  is fully custom; the SDK has no option to remove it, and changing the
  binary is not allowed.
- The agent saw `…/solas-runtime`, "not a git repo", and its own rule "Cite
  every claim". It cited the environment and offered to read the owner's
  project files, which it can't do.
- **Fix:** a short, true note from Solas now goes before the agent's
  instructions: no tools in this conversation, and those environment details
  describe an empty sandbox, not the user's project. The agent's
  instructions follow unchanged.
- Verified:
  - tools are still off (`tools: 0`, `mcpServers: 0`, `dontAsk` in the
    worker log);
  - the real test's replies no longer mention the sandbox.

**How it was verified**
- `lint`, `typecheck`, and `build` pass.
- Vitest: 140 tests pass, three times.
- Playwright: 17 tests pass, three times. The first regression assertion
  failed with 2 copies before the fix and passed after it.
- A real two-turn test through the UI and a fixed worker (Opus 5.5):
  - 1 question and 1 reply per turn, while streaming, after completion, and
    after a reload;
  - 0 runs with more than one reply in the database;
  - exactly one Claude session per message;
  - the right context (Alex, Solas, Next.js, PostgreSQL);
  - no mention of the sandbox.

**Lesson:** when the same content can reach the screen two ways (streamed
and saved), make one of them yield to the other by a stable ID. Don't rely
on timing. And when a duplicate shows up, check each layer from the source
outward: database first, then the worker, then the browser.

## M4A — Tools & permissions (2026-10-24)

**Built:** Agents can now do things, not just talk, but only what you allow.
Solas has a typed tool registry with three real tools: the time, listing
workspace files, and reading a workspace file. You turn tools on per agent
in Agent Builder, optionally with "Ask me first". The worker enforces every
call. When approval is needed, a card in the conversation shows exactly what
will run, with Approve and Reject.

**Concepts**
1. **A tool registry** is the one list of everything an agent could ever run.
   - Each tool is backend code with a contract: Zod schemas for input and
     output, risk, approval policy, time and size limits, and a handler.
   - If it's not in `src/server/tools/registry.ts`, it doesn't exist. No
     instruction, reply, or setting can create one.
2. **How tools reach an agent.**
   - At the start of each run, the worker reads the agent's permissions from
     PostgreSQL. It turns only those tools into `RuntimeTool`s: a name, a
     description, a schema, and an `invoke` function.
   - The Claude adapter serves them through an **in-process MCP server**, the
     SDK's official mechanism (`createSdkMcpServer`). It also lists exactly
     those names in `allowedTools`.
   - Claude Code's built-in tools stay off (`tools: []`). At session start
     Solas checks that the session's tool list is exactly what it
     registered.
3. **How Claude requests a tool.** The model answers with a tool call:
   "`mcp__solas__read_workspace_file` with `{ path: "notes/plan.md" }`".
   Claude Code passes it to the MCP server, which calls Solas's `invoke`. The
   model can only *ask*; it never runs anything itself.
4. **How the backend validates.** The input is parsed with the tool's Zod
   schema. Unknown fields, wrong types, and over-long strings are refused
   before anything runs. The result must also match the output schema, so
   the model never gets malformed data.
5. **How permissions are enforced.**
   - Inside `invoke`, in the worker, for *every* call: the permission is read
     fresh, so turning a tool off works even mid-run.
   - File paths go through `resolveWorkspacePath`, which allows no absolute
     paths, no `..`, no hidden or key files, and no symbolic links.
   - Around it, defense in depth: `allowedTools`, `dontAsk`, a hook that
     denies anything else, and the session check.
   - The UI only *edits* permissions. It enforces nothing.
6. **How approvals work.**
   - The call is saved as `awaiting_approval`, with a 5-minute expiry by the
     database clock. The run's timeout pauses, and the worker checks the row
     every half second.
   - You approve or reject in the card, a Server Action behind the owner
     guard. The update only succeeds while the request is still waiting and
     not expired.
   - On "approved", the worker flips the row to `running` (exactly once) and
     runs the *stored* input. Rejected, expired, or stopped requests never
     run.
7. **How results return to Claude.** `invoke` returns
   `{ text, isError }`. The adapter wraps it as an MCP tool result, and Claude
   continues the same turn with that text: a JSON result, or an error it can
   read and react to (such as "outside the workspace" or "the owner rejected
   this"). Up to 10 such round trips per run.
8. **How to add a tool.**
   1. Write a `ToolDefinition` in `src/server/tools/builtin/`, with schemas,
      risk, limits, summaries, and a handler that throws `ToolError` for
      expected problems.
   2. Add it to `createToolRegistry([...])`.
   3. Write tests.

   It then shows up in Agent Builder, off for every agent. No migration, no
   UI change, no adapter change.

**Lessons**
- **"The model can't do X" must be true in code, not just in the prompt.**
  The prompt names the tools, but the guarantee is the registry, the
  permission check in `invoke`, and the session check.
- **Check, then act on what you checked.** An approval is tied to one row
  and one stored input. The worker runs that input, never a new one from the
  model.
- **Expiry needs one clock.** The worker and the web app both compare with
  PostgreSQL's `now()`, so "expired" means the same thing on both sides.
- **The SDK connects MCP servers lazily** (on the first message), so it
  can't be probed for free. That's why the start-of-session check matters.

**Security limitations (honest list)**
- **Time-of-check to time-of-use:** a symlink swapped in between the path
  check and opening the file is refused at the last step by `O_NOFOLLOW`. A
  link swapped into a *parent* folder in that window isn't. That needs
  someone writing into the workspace at the same moment; acceptable for one
  owner, revisit before writing tools.
- **File contents are untrusted.** A file can contain instructions aimed at
  the agent (prompt injection). The tools are read-only, so the worst case is
  a misleading answer, not an action.
- **Approvals live in the worker's memory while waiting.** If the worker
  stops, the run fails and the request can't be approved any more.
- **Tool results aren't kept as conversation context.** The next message
  sees the agent's final reply, not the raw tool output.

**Files changed**
- New, in `src/server/tools/`:
  - `types.ts`, `registry.ts`, `workspace.ts`, `invoker.ts`;
  - `builtin/current-time.ts` and `builtin/workspace-files.ts`;
  - `tools.test.ts` and `invoker.test.ts`.
- New UI: `components/agents/tool-permissions-fields.tsx` and
  `components/conversations/tool-activity.tsx`.
- New tests: `e2e/tools.spec.ts`.
- Database: `drizzle/0004_tools_and_approvals.sql`, which adds two tables.
- Changed:
  - schema;
  - shared agent validation (`tools`) and the agent service (permissions,
    duplicate) with its queries;
  - runtime types (`RuntimeTool`) and the Claude adapter (MCP server,
    `allowedTools`, hook, session check);
  - executor (tools per run, pausable deadline), prompt (tool-aware note),
    config, and worker;
  - conversation service and actions (tool calls, `decideToolCall`);
  - agent form, details, and pages; conversation view and pages; Badge
    tones;
  - e2e helpers.

**How it was verified**
- `lint`, `typecheck`, and `build` pass.
- Bundle checks:
  - no tool handler code in the browser bundle;
  - no Agent SDK in the web server;
  - 12 Server Actions (`decideToolCall` is new).
- Vitest: 198 tests pass. They cover:
  - registration rules;
  - input and output validation;
  - allowed, disabled-mid-run, and other-agent calls;
  - approve, reject, expiry (and a late decision), stop while waiting, and
    double decisions;
  - path traversal, absolute paths, and symlinks to files and folders;
  - `.env` and key files; size, binary, and non-UTF-8 files;
  - tool timeouts; errors without leaked internals;
  - the adapter's options, hook, and session checks;
  - worker runs that use tools, including a paused timeout while the owner
    decides, with context kept.
- Playwright: 24 tests pass, twice. They cover:
  - enabling tools with the keyboard, "Ask me first", saving, the agent
    page, and turning off;
  - the approval card's exact input, Approve and Reject, and an expired
    request;
  - folded tool activity;
  - the approval card on a phone in light and dark.
- One real run through the UI and the worker:
  - an agent made in Agent Builder (Haiku 5.5) answered "What time is it in
    Oslo, list my notes, summarize plan.md";
  - the session had exactly the three Solas tools (`dontAsk`,
    `apiKeySource: "none"`);
  - time and listing ran automatically, and listing hid the `.env` decoy;
  - the file read waited for Approve in the UI, then ran;
  - the reply used the file's content, in 7.2 s;
  - the test agent and its folder were deleted afterwards.

**Not tested automatically:** the MCP wrapping inside the SDK (covered by
the real run), and approvals across a worker restart (not supported yet).

**Exercise**
- Add a tool `count_workspace_words` that reads a file and returns its word
  count. Reuse `resolveWorkspacePath`, register it, and write two tests: one
  normal file, one path outside the workspace. Then enable it for an agent
  and ask it to count the words in a file.

## M4B — Background tasks and durable execution (2026-11-04)

**Built:** You can hand an agent a task and walk away. Tasks → New task →
choose an agent, title, instructions → Create. The task is saved, the worker
picks it up, and the agent works with its saved instructions, model, and tool
permissions. You can close the browser; the result is in PostgreSQL when you
come back. The task page follows the real progress (status, text so far,
approvals, attempts, timeline). Cancel and Retry work through the worker, and
a worker that crashes mid-task doesn't lose it.

**Concepts**
1. **A durable task queue** is a table of work that outlives every process.
   Solas already had one: `runs`. A task is the owner's request (`tasks`);
   each attempt at it is a run with `task_id`. So there is one queue, one
   worker, one runtime, and the tools and approvals from M4A apply unchanged.
2. **Why a separate worker.** A web request lives for seconds and dies with
   the tab; an agent run can take minutes, spawns Claude Code, and must
   survive the browser closing. The web app only writes rows; the worker,
   which has no network port, does the work. They meet only in PostgreSQL.
3. **How claiming works.** `UPDATE runs SET status = 'running' … WHERE id =
   (SELECT id … WHERE status = 'pending' AND (not_before IS NULL OR not_before
   <= now()) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)`. The row
   lock means "mine"; SKIP LOCKED means a second worker takes the next row
   instead of waiting. In the same transaction the task moves to running.
4. **Locks vs. leases.** A lock lasts only as long as a transaction (here,
   milliseconds). A run lasts minutes, so ownership is a **lease**: the worker
   refreshes `heartbeat_at` every second. A lease older than 30 s means the
   worker is gone, and recovery may take the run over. `worker_id` records
   which worker held it.
5. **How the worker talks to Claude.** Exactly as for conversations: the
   executor builds a prompt (for a task: the title, the instructions, and
   "you can't ask questions, state your assumptions") and calls
   `AgentRuntime.run()`. The Claude adapter is unchanged; it doesn't know
   tasks exist.
6. **How events are stored.** `task_events` is append-only, with sequential
   IDs. Each event is written in the same transaction as the change it
   describes (claimed, started, each tool step, approval, completed, …). The
   messages are Solas's own sentences; data holds IDs and codes only.
7. **Browser-independent execution.** The browser only reads. The task page
   calls `router.refresh()` every second while the task is active, which
   re-renders it on the server from PostgreSQL. Closing the tab stops the
   reading, never the work.
8. **How cancellation works.** Queued: cancelled at once with its pending run.
   Running: `cancel_requested_at` is set; the worker's heartbeat sees it
   within a second, aborts the Claude call, withdraws any pending approval,
   and records "cancelled". Until then the page says "Cancelling…". The worker
   also checks right before starting Claude, so an early Cancel costs nothing.
9. **If the worker crashes.** The run stays "running" with an ageing lease.
   The next worker (on start, then every 30 s) marks it failed
   (`worker_stopped`) and asks the retry policy: retry once after 15 s if it
   is safe (no tool with side effects ran, no approval pending), otherwise
   "interrupted" for you to decide. A Ctrl+C shutdown goes the same way,
   without the 30 s wait.
10. **If Claude hits a usage limit.** The attempt fails with Solas's own
    message and is **never** retried automatically: retrying would only hit
    the limit again. You retry after the reset.
11. **Approvals in long-running tasks.** The attempt waits (its timeout
    paused) and the task shows "Waiting for approval" with the same card as
    conversations. The Claude session waits in the worker's memory, so if the
    worker stops, the request is withdrawn and the task is interrupted. Retry
    starts a new attempt that asks again. Resuming the old session would
    need provider session resume, which M3B rejected.
12. **Toward hosting.** Every state is in the database, the worker can
    restart or move, and two workers can safely share one database. On a VPS
    only the credential (M10) and owner login (M9) change.

**Lessons**
- **A state machine belongs in the WHERE clause.** `UPDATE … WHERE status IN
  (allowed)` makes the database enforce the rule at the moment of change. An
  `if` in code, followed by an UPDATE, leaves a gap another process can use.
- **Pick one lock order.** The worker locks run, then task; at first Cancel
  locked task, then run. Two transactions waiting on each other is a
  deadlock. A test that races Cancel against a claim ten times made the
  order part of the design.
- **"Stopped" must win over a late result.** A test found that a runtime
  returning a result after Cancel was saved as completed. Now an aborted run
  is always recorded as stopped, whatever arrives afterwards.
- **Exactly once is a promise about the database only.** Locks ensure one
  worker per attempt and one result per task. Whether an outside action
  happened once, Solas can't know if the worker died at the wrong moment.
  That's why tools declare `sideEffects`, and why such attempts are
  interrupted, not repeated.
- **Flaky tests are usually honest about timing.** Two intermittent failures
  were tests that checked a state a few milliseconds too early, or left a
  "crashed" execution running into the next test. Model a crash as the state
  it leaves behind, not as a half-alive process.
- **zsh doesn't split `$VAR` into words** the way bash does: `kill -9 $PIDS`
  passed one argument containing every PID. Scripts that rely on word
  splitting should run in bash.

**Security and reliability limitations (honest list)**
- **Approvals don't survive a worker restart** (see concept 11).
- **Exactly-once side effects aren't guaranteed** (see the lessons). All
  current tools only read, so today nothing can be duplicated.
- **Recovery takes up to about a minute** after a crash: a 30 s lease plus
  the 30 s recovery timer, then the 15 s backoff.
- **Polling, not push:** about one server render per second per open task
  page. Fine for one owner; SSE from `task_events` is the upgrade path.
- **Task results are Markdown from the model,** rendered safely (no raw HTML,
  no images), as in conversations.
- **No task deletion.** Tasks go away with their agent. Deleting one task
  needs a decision about its history first.
- **Subscription use stays local and personal.** Tasks run on your Mac with
  your own Claude Code sign-in. Unattended hosted use is decided in M10.

**Files changed**
- New, in `src/server/tasks/`:
  - `lifecycle.ts` (state machine, `transitionTask`, retry policy);
  - `service.ts`, `queries.ts`, and `errors.ts` (web side);
  - `execution.ts` and `events.ts` (worker side, timeline);
  - `lifecycle.test.ts` and `tasks.test.ts`.
- New in `src/server/runs/`: `worker-loop.ts` (concurrency, recovery timer).
- New, in `src/lib/tasks/`: `validation.ts` and `status.ts` (shared with the
  browser).
- New UI:
  - pages: `app/(app)/tasks/` (list, `new/`, `[taskId]/`, actions, error);
  - components: `components/tasks/` (list and toolbar, form, detail,
    actions, approvals, status badge), plus `live-refresh.tsx` and
    `use-now.ts`.
- New tests: `e2e/tasks.spec.ts`.
- Database: `drizzle/0005_tasks_and_task_events.sql`. It adds two tables and
  four `runs` columns, and makes `runs.conversation_id` and `user_message_id`
  optional (a check requires a conversation or a task). It deletes nothing.
- Changed:
  - schema;
  - executor (task branches, several runs at once, cancel check before start,
    stopped beats a late result, per-run recovery);
  - worker entry (worker ID, concurrency, loop);
  - config (task limits, `workerConcurrency`) and `.env.example`;
  - prompt (task prompt, "task" wording);
  - tool types (`sideEffects`) and the invoker (step events);
  - conversation service (only conversation runs can be retried or
    cancelled there);
  - conversation view (`useNow` moved out) and tool activity
    (`ApprovalCard` exported);
  - Badge (`active` tone), breadcrumbs (task labels), load error, action
    errors, the agent delete warning (mentions tasks);
  - e2e helpers.

**How it was verified**
- `lint`, `typecheck`, and `build` pass. One build warning (whole-project
  tracing from `workspace.ts`) is unchanged from M4A.
- Vitest: 247 tests pass, three full runs in a row; the task file passed ten
  runs in a row. New tests cover:
  - creating, validation, and unknown, disabled, or unconfigured agents;
  - duplicate submits, including two at the same moment;
  - claiming, two workers racing, and the result saved;
  - completed tasks never running again;
  - provider failure, usage limit (no retry), timeout (never a success),
    one bounded retry with backoff, and manual retry (only once);
  - cancelling a queued or running task, and Cancel racing a claim;
  - shutdown and crash recovery, expired leases, a live worker left alone,
    queued tasks kept across restarts;
  - side-effect tools interrupted, not repeated; read-only tools retried;
  - approvals approved, rejected, expired, withdrawn on Cancel, and pending
    during a crash or shutdown;
  - permissions removed mid-run;
  - list filters, search (wildcards taken literally), and counts;
  - concurrency 1 and 2.
- Playwright: 38 tests pass (14 new). They cover:
  - the form (only ready agents, one task per double submit, field errors,
    keyboard only);
  - live progress without reload, "written so far", the saved Markdown
    result;
  - a closed browser, then the result on the next visit;
  - Cancel (queued, and running with "Cancelling…"), Retry, interrupted;
  - an approval in a task;
  - filters, search, and counts in the URL;
  - a 375 px phone in light and dark (no sideways scroll, AA contrast).
- Real runs with Claude (dev app, real worker, a "Research Assistant (M4B
  test)" agent made in Agent Builder, Haiku 5.5 to save plan usage):
  - "Research AI Agent Architectures": created in the UI, seen running, then
    the browser was closed at 00:18:26. Claude finished at 00:18:31 (7.7 s,
    856 output tokens). On return the page showed the saved result
    (2,298 characters, Markdown table); PostgreSQL had the task completed
    with one attempt. The session reported `apiKeySource: "none"`, no tools,
    `dontAsk`.
  - Crash: the worker and its Claude Code child were killed with SIGKILL
    right after the session started. The task stayed "running" with an
    ageing lease. A new worker marked attempt 1 `worker_stopped` about 44 s
    after the crash (30 s lease, then its next recovery check), queued
    attempt 2, started it 16 s later, and completed it 9 s after that.
  - Cancel and Retry in the UI: "Cancelling…" then "Cancelled" (attempt 1
    stopped after 4 s, partial text kept); Retry ran attempt 2 to completed.
    The timeline had all ten events in order.
  - Afterwards, every completed task still had exactly the attempts above:
    nothing ran again by itself.
  - The test agent and its five tasks are still in your dev database so you
    can look at them. Deleting the agent deletes them.

**Not tested automatically:** a real Claude usage limit (the mapping is unit
tested with a fake), and two worker processes on one machine at once (the
claim race is tested with two executors on one database).

**Exercise**
- Make the automatic retry count configurable per task. Add a "Retries if
  the worker stops" select (0–2) to the New task form, validate it in
  `createTaskSchema`, store it in `auto_retries_left`, and write two tests:
  one where a crash with 0 retries ends as "interrupted", one where 2 retries
  allow a second automatic attempt. Hint: `decideAfterFailure` doesn't need
  to change.

## M5A — Multi-agent delegation (2026-11-04)

**Built:** Agents can now work together. In Agent Builder you allow an agent
to delegate to chosen agents. In a task, that agent can hand one subtask to
one of them with the `delegate_to_agent` tool. Solas checks the request,
creates a linked child task, and runs it as the other agent. When it's done,
the first agent gets the result in a follow-up run and finishes the task.
The task page shows the whole chain: who delegated what to whom, the
child's status and result, and the parent's final result.

**Concepts**
1. **Multi-agent orchestration** means several agents contributing to one
   piece of work, with something deciding who does what and how results
   flow back. In Solas the "something" is plain data: tasks linked as parent
   and child, and rules in the backend. There's no orchestration framework
   and no agents chatting freely.
2. **Delegation vs. an ordinary task.** A delegated task is created by the
   backend at an agent's request, not by you. It carries `parent_task_id`
   and `depth = 1`, gets only the words its parent sent, and its result goes
   back to the parent. Everything else (queue, worker, retries, cancel,
   approvals) is the same task machinery as M4B.
3. **How parent and child are stored.** `tasks.parent_task_id` is the
   hierarchy. `task_delegations` is the record of the request: target, exact
   text sent, expected output, status, the parent's notes, and when the
   result was handed over. The result itself stays on the child task.
4. **Agents communicate through persisted results.** The parent never talks
   to the child. It writes a request (stored); the child writes a result
   (stored); the parent's follow-up run reads both. Every step can be
   inspected and survives restarts.
5. **How the worker schedules the child.** The child is just another
   pending run in `runs`. The worker claims it like any other, oldest
   first, so a child created by a parent is picked up as soon as a slot is
   free.
6. **How deadlocks are prevented.** A parent that "waits" inside a worker
   slot would block its own child when there's only one slot. So waiting is
   a state, not a process: the parent's run ends, the task becomes
   `waiting_on_delegate`, and the child takes the free slot. When the child
   finishes, the same transaction queues the parent's follow-up run. Lock
   order (task run → task → parent task → delegation rows) is the same
   everywhere, and the parent's side never locks a child's rows, so two
   transactions can't wait on each other either.
7. **How delegation permissions work.**
   - Off by default: no row in `agent_delegation_targets`, no tool.
   - The tool is only offered in a task's own work run, at depth 0, and
     lists the enabled targets.
   - Each call is checked again in one transaction: the target row exists,
     it isn't the agent itself, the target is enabled with a model, the
     depth and budget hold, and the same request returns the same child.
   - The model's text can't change any of this; it only fills in the
     request.
8. **How failures and retries are handled.**
   - A child that fails or is cancelled lets the parent finish with that
     knowledge.
   - An interrupted child keeps the parent waiting until you retry or
     cancel it.
   - Cancelling a parent cancels its child.
   - A lost parent run is retried as in M4B (delegating is idempotent).
   - A usage limit is never retried automatically, in parent or child.
9. **How context is isolated.** The child gets only the request text: not
   the parent's instructions, not your original task, not conversations or
   files. It works with its own instructions, model, tools, approvals, and
   workspace. The parent doesn't gain the child's tools, and its follow-up
   run can't delegate again. The child's result is shown to the parent as
   material from another agent, not as instructions.
10. **Toward larger teams.** Depth, children per task, and targets are
    configuration and rows, not code paths. A team page (M5B) can edit the
    target graph. More children per task need a higher limit, and the
    follow-up prompt already handles a list. Depth two would first need
    cycle checks on the graph.

**Lessons**
- **"Waiting" should be data.** The tempting design keeps the parent's
  Claude session open until the child is done. That ties up a worker slot,
  dies with the process, and deadlocks with one worker. A state in a row,
  plus a follow-up run, does none of that.
- **Resumption is reconstruction, and that's fine if it's honest.** The
  provider can't resume a session Solas didn't let it save. The follow-up
  gets a bounded, explicit summary instead, and the prompt says so.
- **Two orders, one outcome.** With two workers, the child can finish before
  the parent's run ends. Both paths (parent ends first, child ends first)
  were written and tested, so the result is the same either way.
- **Disabled targets shouldn't even be offered.** Listing only enabled
  targets keeps the model from planning around an agent it can't use. The
  backend still refuses one if asked directly.
- **Test fakes need the same care as real code.** Two failures came from
  test runtimes: one waited for an abort that had already happened, and one
  released a waiting parent before the child's result was saved.

**Security and reliability limitations (honest list)**
- **One child per task, depth one.** That's deliberate for M5A, not a
  general orchestration system.
- **The parent decides what to share.** Solas passes only the request text,
  but if the parent copies sensitive material into it, the child sees that
  material. The request is shown on the task page.
- **A child's result is untrusted input** to the parent (prompt injection
  between agents). It's labelled as material, and the parent's own
  permissions still apply, but a determined result could mislead the parent.
- **The follow-up is a new session.** The parent remembers only what is in
  its notes and the result.
- **No timeout for waiting itself.** A parent waits as long as its child is
  queued or interrupted. Each child attempt has its own time limit, and you
  can always cancel.
- **Cost:** a delegation means at least three Claude calls (parent work,
  child, parent follow-up).

**Files changed**
- New:
  - `src/server/tasks/delegation.ts` (rules, child creation, waiting,
    follow-up) and `src/server/tasks/cancel.ts` (one cancel path; stopping
    orphaned children);
  - `src/server/tools/builtin/delegate.ts` (the tool);
  - `src/components/agents/delegation-fields.tsx` (Agent Builder section);
  - tests: `src/server/tasks/delegation.test.ts` and
    `e2e/delegation.spec.ts`.
- Database: `drizzle/0006_delegation.sql`. It adds two tables and three
  columns (`tasks.parent_task_id`, `tasks.depth`, `runs.purpose`), and a
  task status, `waiting_on_delegate`. It deletes nothing.
- Changed:
  - schema; lifecycle (new transitions);
  - execution (parent waits, child reports back, retries keep purpose);
  - executor (work vs. follow-up runs, child cleanup) and prompt
    (`buildContinuationPrompt`); config (`DELEGATION_LIMITS`);
  - task service (cancel cascade, child retry rule, parent and children in
    the detail, "delegated by" in the list);
  - tool types (`grantedBy`, `delegate`), registry (the tool, kept out of
    the switches), and invoker (offers and checks it; only file tools get a
    workspace);
  - agent validation, service, and queries (`delegateTo`);
  - agent form, details, and new/edit pages;
  - task detail and list; task status labels and filters;
  - e2e helpers, test helpers, and existing tests (new limits field).

**How it was verified**
- `lint`, `typecheck`, and `build` pass.
- Vitest: 271 tests pass, twice in a row; the delegation file passed eight
  runs in a row. 23 new tests cover:
  - the full flow, step by step: relationships, the child's isolated prompt,
    the parent's follow-up prompt, the final result, and the timeline;
  - one worker (no deadlock), and two workers (the child finishes first);
  - no targets, an unknown or disabled target, self, depth and cycles,
    budget, and duplicate requests across a cut-off run;
  - conversations never delegating, and tools kept to each agent;
  - child failure and usage limit;
  - cancelling the parent (queued or running child) and cancelling the
    child;
  - an interrupted child, then Retry;
  - approvals in the child (visible on the parent; rejected never runs);
  - worker restart and orphaned children;
  - detail and list views, and agent service targets.
- Playwright: 45 tests pass (7 new). They cover:
  - Agent Builder delegation (keyboard, off by default, validation, save,
    turn off);
  - the parent and child pages following the worker, with navigation both
    ways;
  - a child approval decided from the parent;
  - parent cancel cascading to the child;
  - list labels;
  - a 375 px phone in light and dark.
- Real run with Claude (dev app, real worker):
  - "Writing Assistant" was created in Agent Builder (Haiku 5.5).
  - Your "Research Assistant" (Opus 5.5) was set to delegate to it, in the
    Delegation section.
  - Task: "Analyze the differences between a chatbot, a tool-using AI
    agent, and a multi-agent system. Ask the Writing Assistant to turn your
    findings into a concise structured report, then return the final
    result."
  - Research Assistant's work run (34 s) analysed, then delegated with its
    findings and an expected output. The task waited without a worker slot.
  - Writing Assistant's child task (depth 1) ran in 17 s and saved a
    3,410-character report.
  - The follow-up run (31 s) got the notes and report and saved a
    6,362-character final result. It even listed the changes it made to the
    Writing Assistant's draft.
  - 83 s in total, with 13 events on the parent's timeline in order.
  - The delegation is still configured, and both tasks are in your dev
    database. Turn it off under Research Assistant → Edit → Delegation.

**Not tested automatically:** a real usage limit in a child (faked), and
two worker processes delegating at once (two executors on one database are
tested).

**Exercise**
- Add an "Ask me first" option to delegation targets, so a delegation waits
  for your approval like a tool call. Hint: give `agent_delegation_targets`
  a `mode` column, return it from `permissionFor` in the invoker, and the
  existing approval flow does the rest. Write one test where a rejected
  delegation creates no child task.

## M5B — Teams (2026-11-04)

**Built:** A Teams section. You can group agents into teams, give a team a
coordinator, and see on one page who is in it, what each member can do,
who may delegate to whom, the team's tasks, and recent activity on them.
Delegation between members is set right there, and it is still the same
explicit M5A permission. A task can be given to a team when you create it.

**Concepts**
1. **How teams are stored.**
   - `teams` holds the name and description.
   - `team_members` holds one row per agent per team, with a role. The
     primary key `(team_id, agent_id)` makes a duplicate membership
     impossible.
   - Foreign keys with cascade mean deleting a team or an agent removes
     only the membership rows.
2. **How membership works.** The form sends the members as a set. The
   service checks that the agents exist, then replaces the set in one
   transaction: it removes the missing rows and adds the new ones (`ON
   CONFLICT DO NOTHING` keeps the existing rows as they are).
3. **How coordinators are assigned.** There's no `coordinator_id` column.
   The coordinator is the member whose role is "coordinator", and a
   *partial unique index* (`unique (team_id) where role = 'coordinator'`)
   allows one per team. So a coordinator is always a member, and removing
   the member removes the role. When the coordinator changes, the service
   demotes everyone first and then promotes the new one, so the index holds
   at every step. The role is a label: it grants no permission.
4. **How delegation permissions are enforced.** There is still one source
   of truth, `agent_delegation_targets`. The team page edits a member's
   targets within the team and leaves targets outside the team alone. Being
   in a team or coordinating it gives nothing. The delegation tool checks
   the explicit target on every call, with the M5A limits unchanged.
5. **How tasks are associated with teams.**
   - `tasks.team_id` is set only when you choose a team for a new task, and
     only through one of its members.
   - A delegated task inherits its parent's team.
   - The link is never derived from membership, so later changes don't
     rewrite history.
   - Deleting the team sets the link to null; the task stays.
6. **How to extend it later.**
   - Per-team limits: columns on `teams`, read by the worker.
   - Archiving: an `archived_at` column instead of delete.
   - Team-level delegation history: a query joining `task_delegations` to
     the team's tasks.
   - None of these needs a change to the task engine.

**Lessons**
- **Let the schema make the invalid state impossible.** "The coordinator
  must be a member" could be a check in code that someone forgets. As a
  role on the membership row with a partial unique index, it can't be wrong
  at all.
- **One source of truth for permissions.** It was tempting to store team
  delegation separately. Editing the same `agent_delegation_targets` from
  the team page means the agent page, the team page, and the worker can
  never disagree.
- **Explicit beats derived for history.** Deriving a task's team from
  current membership would rewrite the past every time membership changes.
  A link chosen at creation stays true.
- **Locators can be too eager.** `getByLabel("Team")` matched "Teams" in the
  navigation. Name-based selectors (`select[name="teamId"]`) are more
  precise for fields.

**Limitations (honest list)**
- **Deleting a team removes the link from its tasks.** They stay, but no
  longer show which team they were for. Archiving would keep it (later).
- **The team task list shows the newest 20 tasks and 15 events.** Tasks
  filtered by team shows them all.
- **No team-level limits yet.** The M5A limits apply per task.
- **The coordinator is only a label.** It doesn't route work or approve
  anything.

**Files changed**
- New:
  - `src/server/teams/` (service, queries, errors, tests) and
    `src/lib/teams/validation.ts`;
  - `src/app/(app)/teams/` (list, new, team page, edit, actions,
    not-found, error);
  - `src/components/teams/` (list, form, team page, delegation editor,
    delete dialog);
  - `e2e/teams.spec.ts`.
- Database: `drizzle/0007_teams.sql`. It adds two tables and
  `tasks.team_id`, and deletes nothing.
- Changed:
  - schema;
  - task validation, service, and queries (team link and filter);
  - delegation (children inherit the team);
  - New task form and page (Team field), Tasks page and list (team filter
    and label), task page (team link);
  - agent page (its teams);
  - navigation, icons, breadcrumbs, action errors, load errors;
  - e2e helpers.

**How it was verified**
- `lint`, `typecheck`, and `build` pass.
- Vitest: 284 tests pass. 13 new tests cover:
  - creating, validation (name, unique name, unknown agents, coordinator
    not a member, duplicates), and updating members and the coordinator;
  - the database refusing duplicates and a second coordinator;
  - deleting a team (agents, tasks, and runs stay) and deleting an agent
    (membership and coordinator role go);
  - member status and capabilities, including disabled and unconfigured
    agents;
  - membership granting no delegation, with the backend refusing it;
  - setting targets within a team while keeping outside ones, and the
    refusals;
  - task links (only through members, never via membership), history kept
    when membership changes, and delegated tasks keeping the team.
  - All M5A delegation tests still pass.
- Playwright: 52 tests pass (7 new). They cover:
  - the demo, through the UI in the isolated e2e database: "Solas
    Development Team" with Project Manager (coordinator), Developer, and
    Research Assistant; delegation set with the keyboard; a team task
    shown on the team page, in its activity, and in the team's task list;
  - editing, deleting (agents and tasks kept), search and filter, agent
    pages, and agent deletion;
  - disabled members;
  - a 375 px phone in light and dark.
- No demo team was created in your own database, and no AI task was run.

**Exercise**
- Add an "Archive" action for teams. Give `teams` an `archived_at` column,
  hide archived teams from the list (with a "Show archived" toggle), and
  keep their task links. Write one test showing an archived team's task
  still shows its team.
