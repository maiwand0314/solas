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
