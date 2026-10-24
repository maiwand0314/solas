# Solas — Project Plan

_Last updated: 2026-10-23_

## Vision

Solas is a private platform for running a **team of AI agents**. One owner
creates agents, gives each a role and instructions, talks to them, assigns
them tasks, and comes back later to review results — from a laptop or a phone,
without keeping a browser (or eventually the laptop) open.

Each agent eventually has:

- a name, role, and custom instructions
- a configurable model
- its own conversations, tasks, and working context (a workspace directory)
- controlled access to tools, with clearly defined permissions
- execution history
- scheduled tasks
- the ability to work independently, asking for approval when it must

Solas is also a learning and portfolio project. It is written from scratch: no
code, branding, or UI is taken from MausBot / OpenMausBot or any other product.

## Guiding principles

1. **Incremental.** Each milestone ships the smallest complete, working slice.
2. **Understood.** Every milestone ends with an explanation, verification
   steps, and what was learned.
3. **Secure by default.** Server-side execution only, least-privilege tools,
   approvals for sensitive actions, nothing publicly exposed without auth and
   a security review.
4. **Official paths only.** Claude is reached only through officially
   supported Anthropic tooling and authentication. No token extraction, no
   unofficial auth, no working around limits.
5. **Replaceable model layer.** Agents talk to an `AgentRuntime` interface,
   not to a specific SDK.
6. **Restrained, premium UI.** Calm and precise; no filler or fake data.
7. **Few dependencies.** Each one is explained and approved before it is added.

## Key decision: how agents reach Claude

Researched against current Anthropic documentation on 2026-10-23 (see
`ARCHITECTURE.md` §5 for details and sources).

**Decision for the personal prototype:** run agents through the **Claude Agent
SDK** (`@anthropic-ai/claude-agent-sdk`). It runs the unmodified Claude Code
binary and uses the Claude Code login on the machine. The owner signs in
through Anthropic's own flow (`claude auth login`), and Solas never reads,
stores, or forwards that credential. This needs no API credits.

**Why this is the defensible path, and its limits:**

- Anthropic's terms allow an end user to sign in to the **unmodified Claude
  Code binary with their own subscription**. They also describe the
  advertised plan limits as assuming "ordinary, individual usage of Claude
  Code and the Agent SDK".
- The same docs say developers building **products or services** with the
  Agent SDK should use **API keys**. They also say third parties may not offer
  claude.ai login to others or intermediate subscription credentials.
- Solas is a single-owner tool, used only by the person whose subscription
  pays for it, and never offered to anyone else. That is the narrow case where
  subscription use is reasonable. It is **not** guaranteed for hosted or
  multi-user use, and Solas must not depend on it.
- Heavy autonomous use (many scheduled agents running around the clock) is not
  "ordinary individual usage". Solas will cap concurrency and run budgets.

**Consequences:**

- The runtime interface allows an **Anthropic API (Client SDK, API key)**
  adapter to be added without touching UI, storage, or agent definitions.
- Before hosted deployment (M10), the subscription question is re-checked
  against the then-current terms. The default for hosted use is an API key,
  unless Anthropic's terms clearly allow otherwise.

## Minimum viable product (MVP)

The MVP runs **locally on the owner's Mac**, bound to `127.0.0.1`. It proves
the core loop: configure agents, talk to them, and let their work continue in
the background.

### In scope

| Capability | Done when |
| --- | --- |
| App shell | Sidebar + content layout, temporary "Solas" wordmark, responsive, keyboard accessible |
| Themes | Light, dark, and system; persisted; no flash on load |
| Agent management | Create / edit / archive agents: name, role, instructions, model, tool profile |
| Conversations | Per-agent conversations stored in PostgreSQL; list, open, rename, archive |
| Agent runtime | `AgentRuntime` interface + Claude Agent SDK adapter, locked down (no shell, no file writes, isolated from the owner's personal Claude Code settings) |
| Background worker | A separate process executes runs from a database queue. Closing the browser does not stop a run; the result is there when you return |
| Live output | The conversation view streams run events (text, status) while a run is active and shows full history afterwards |
| Run history | Every run is recorded with status, timing, and errors |

### Out of scope for the MVP (planned later)

- Tools beyond plain conversation, and the approval flow (M6–M7)
- Tasks and schedules (M8)
- Authentication (M9) — required before any network exposure
- Deployment / phone access (M10)
- Integrations, notifications, multi-agent collaboration (M11+)
- Any API-key runtime (added when needed)

### MVP success criteria

- Create an agent, send it a message, close the tab, reopen later: the full
  reply and run record are there.
- A run fails visibly and safely when Claude Code is not signed in, the plan
  limit is hit, or the worker is stopped mid-run.
- The worker exposes no network port. The web app holds no Claude credential.
- Both themes pass WCAG AA text contrast. Everything works keyboard-only and at
  375px width.
- `lint`, type check, tests, and `build` pass.

## Roadmap

Milestones are deliberately small. Details are refined at the start of each,
not up front. Each one stops for review before the next starts.

### Phase 1 — MVP (local)

**M0 — Documentation and architecture** *(this milestone)*
The five documents, the runtime decision, and a verified fresh project.

**M1 — Design system and application foundation** *(done 2026-10-23)*
Design tokens; light/dark/system theme without flash; shell with a collapsible
sidebar (`[`), top bar with breadcrumbs, mobile drawer, and a ⌘K command menu;
pages for Overview, Agents, Conversations, Tasks, Automations, and Settings
with honest empty states; a loading skeleton; primitives (Button, IconButton,
Input, Dialog, Badge, Kbd, Skeleton, PageHeader, EmptyState).
Concepts: CSS variables, Tailwind v4 `@theme`, hydration, Server vs. Client
Components, route groups, native `<dialog>`, the ARIA combobox pattern.
No new dependencies.

**M2A — Agent data architecture and backend** *(done 2026-10-23)*
- Local PostgreSQL 18 via Docker Compose, bound to `127.0.0.1`.
- Drizzle ORM with versioned SQL migrations; an `agents` table.
- A server-only agent service (create, list, get, update, delete,
  enable/disable) with Zod validation and database error mapping.
- A provider registry kept separate from agent storage. No provider is
  available yet, so every agent is honestly "not configured".
- Server Actions behind a fail-closed owner guard.
- Vitest unit and integration tests against a separate test database.
- A dev-only CLI for manual checks.
- Dependencies added (approved): `drizzle-orm`, `postgres`, `zod`,
  `server-only`; dev: `drizzle-kit`, `vitest`, `tsx`. `@types/node` was raised
  to ^24 to match the Node 24 runtime.

**M2B — Agent Builder UI** *(done 2026-10-24)*
- The Agents page lists stored agents inside `<Suspense>` (Cache Components),
  with instant client-side search.
- Pages for new agent, agent details, and edit. Create and edit share one form
  that validates with the same Zod schemas as the server, then calls the M2A
  Server Actions and shows the server's field errors.
- Enable/disable (optimistic), duplicate (copies start disabled), and delete
  with a confirmation dialog.
- A read-only provider/model section that honestly shows "not configured".
- Role and instructions are now required.
- Reads go through owner-guarded query helpers (`src/server/agents/queries.ts`).
- Concepts: Server Actions from client components, transitions and pending
  states, `useOptimistic`, accessible field errors, Suspense under Cache
  Components. `useActionState` was considered and not used (see the learning
  log). No new dependencies.

**M3 — Agent runtime spike**
Define `AgentRuntime` and Solas's own `RunEvent` types. Implement the Claude
Agent SDK adapter and run it from a terminal script against a stored agent.
No tools; isolated settings. Verify subscription sign-in works through the
official flow and that errors (not signed in, limit reached) are classified.
Concepts: the agent loop, SDK message stream, adapters and interfaces,
credential precedence, why the runtime is isolated.
Dependency to approve: `@anthropic-ai/claude-agent-sdk`.

**M4 — Worker and runs**
`runs` and `run_events` tables, a worker process that claims queued runs
(`FOR UPDATE SKIP LOCKED`), executes them through the runtime, records events,
and handles cancellation, timeouts, and crash recovery.
Concepts: why agent work does not belong in web requests, job states,
idempotency, process lifecycle.

**M5 — Conversations and live chat** *(MVP complete)*
`conversations` and `messages`. Sending a message stores it and enqueues a run.
The UI follows the run live over Server-Sent Events and shows history after.
Conversation continuity via stored history and/or SDK session resume
(decided in M5).
Concepts: SSE, append-only histories, optimistic UI, reconnecting streams.

### Phase 2 — Controlled autonomy (still local)

**M6 — Tools, workspaces, and permissions**
Per-agent workspace directory, tool profiles (none / read workspace /
read-write workspace / custom Solas tools via an in-process MCP server), a
policy gate (`PreToolUse` hook) that enforces paths and tool allowlists.
Shell stays disabled.

**M7 — Approvals**
Sensitive tool calls pause the run and create an approval request. The owner
approves or denies in the UI and the run continues. Includes timeouts,
expired approvals, and an audit trail.

**M8 — Tasks and schedules**
Assign one-off tasks to an agent, see status and results. Schedules (cron-like)
with run history, pause / resume, and budgets per agent.

### Phase 3 — Away from the laptop

**M9 — Owner authentication and hardening**
Single-owner login (password with `node:crypto` scrypt, passkeys considered),
database sessions, `proxy.ts` redirects plus authoritative checks in the data
layer, rate limiting, security headers, CSP.

**M10 — Private deployment to a Hetzner VPS**
Security review first. Paid provisioning only after explicit approval.
Private access (e.g. Tailscale) rather than public exposure where possible,
reverse proxy with TLS, web + worker as separate services, PostgreSQL with
tested backups. Runtime authentication re-decided against current terms.

**M11+ — Growth (re-evaluated one at a time)**
Notifications to phone, integrations (OAuth, encrypted credentials, per-tool
approval policies), agent collaboration, API-key runtime adapter, sandboxed
execution for any future shell or code tools.

## Open decisions

| Decision | When | Notes |
| --- | --- | --- |
| **Team seat ownership** | Before M3 | This Mac's Claude Code is signed in to a Team plan in the "Xala team" organization. Personal-project usage counts against that seat and falls under that organization's commercial agreement and admin policies. Confirm with the org admin that this use is acceptable, or use a personal plan / API key instead. |
| Runtime isolation (dedicated `CLAUDE_CONFIG_DIR` for Solas vs. default) | M3 | A dedicated directory keeps Solas agents away from the owner's personal Claude Code settings, memory, and sessions, at the cost of one extra sign-in through the official flow |
| Local PostgreSQL install method | ✓ M2A | Docker Compose with `postgres:18-alpine` (same image works on a Linux VPS) |
| Validation library | ✓ M2A | Zod 4 |
| Agent deletion once history exists | M5 | Hard delete today. Once conversations reference agents, choose archive vs. cascade |
| How the worker runs TypeScript | M4 | Node 24 native type stripping vs. `tsx` |
| Conversation continuity | M5 | Replay stored history vs. SDK session resume (sessions live in the Claude Code config directory) |
| Test tooling | ✓ M2A | Vitest (unit + integration). Playwright for key UI flows later |
| Hosted runtime credentials | M10 | Re-check terms; API key by default for hosted use |
| Hosting cost and setup | M10 | Explicit approval required |
| Final name, logo, brand | Later | Typographic wordmark until then |

## Risks

| Risk | Mitigation |
| --- | --- |
| Subscription terms change or do not cover the use | Replaceable runtime; API-key adapter ready by M10; re-check terms at each runtime milestone |
| Hitting plan usage limits | Concurrency 1 by default, per-run turn and time budgets, visible "limit reached" state |
| Agent does something harmful | No shell, workspace-only file access, policy hook, approvals, audit log |
| Prompt injection via tool output | Least-privilege tools; approvals for anything with side effects |
| Secrets leak to the client or Git | `server-only` modules; `.env*` git-ignored; Solas never handles Claude credentials |
| Scope creep | Milestone gates and the out-of-scope list |
| Next.js version drift vs. tutorials | Use bundled docs in `node_modules/next/dist/docs/` |
| Generic-looking UI | Design system before screens; review both themes every milestone |
