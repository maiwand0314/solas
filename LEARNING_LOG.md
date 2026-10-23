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
