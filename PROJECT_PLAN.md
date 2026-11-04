# Solas — Project Plan

_Last updated: 2026-11-04_

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

- Tools beyond plain conversation, and the approval flow (M6–M7; foundation in M4A)
- Schedules (M8; one-off tasks arrived in M4B)
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

**M0 — Documentation and architecture** *(done 2026-10-23)*
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

**M3A — First working agent engine** *(done 2026-10-24)*
One real execution path, end to end: pick an agent, send a message, get a
genuine Claude reply. It pulled forward the minimum of the old M3–M5:
- `AgentRuntime` interface and a Claude Agent SDK adapter (no tools, isolated
  settings, subscription login only, verified at session start).
- `conversations`, `messages`, and `runs` tables; `runs` is the job queue
  (pending → running → completed / failed / cancelled).
- A worker process (`npm run worker`) that claims runs with
  `FOR UPDATE SKIP LOCKED`, one at a time, with timeout, Stop, shutdown, and
  crash recovery.
- Conversations UI: agent picker, chat view, real run status by polling.
- Earlier turns are replayed as a transcript; no SDK session resume.
- Dependency added (approved): `@anthropic-ai/claude-agent-sdk` 0.3.310.

**M3B — Persistent conversations, context, and streaming** *(done 2026-10-24)*
- Conversations UI: a list beside the open conversation on wide screens,
  rename and delete (with confirmation), timestamps, Markdown replies with
  copyable code, and Retry for a failed or stopped reply.
- Real streaming: SDK text deltas → `runs.partial_output` → the view polls
  twice a second. No fake typing.
- Context: bounded history rebuilt from PostgreSQL (last 20 messages /
  60,000 characters). SDK session resume was evaluated and not used
  (ARCHITECTURE §5.5).
- Reliability:
  - idempotent sends (`client_message_id`);
  - worker heartbeats, and recovery that only touches runs whose worker is
    gone;
  - no automatic re-runs;
  - deleting a conversation stops its reply.
- Tests: Vitest 130 (fake providers) and Playwright 14 (own database, no
  Claude).
- Dependencies added (approved): `react-markdown`, `remark-gfm`, and
  `@playwright/test` (dev).

**M4A — Tools & permissions** *(done 2026-10-24)*
Pulled forward from the old M6 and M7, as the smallest secure slice:
- **Tool registry:** typed `ToolDefinition`s with Zod input and output
  schemas, risk, approval policy, and limits. Three tools: current time,
  list workspace files, and read a workspace file (read-only, inside
  `~/Solas/workspaces/<agent-id>`).
- **Permissions:**
  - per agent in `agent_tool_permissions`, off by default, edited in Agent
    Builder;
  - enforced in the worker on every call (permission → validation →
    approval → execution → output contract → record).
- **Claude:** tools reach it through the SDK's in-process MCP server. Built-in
  tools stay off, and the session's tool list is verified at start.
- **Approvals:** "Ask me first" or approval-required tools wait for Approve
  or Reject in the conversation. They expire after 5 minutes and pause the
  run's timeout. Rejected, expired, or stopped requests never run.
- **Tool activity:** shown in conversations; finished runs fold it away.
- **Tests:** Vitest 198, Playwright 24, and one real run where Claude used
  three tools with one approval.

**M4B — Background tasks and durable execution** *(done 2026-11-04)*
Pulled forward from M8 (tasks; schedules stay in M8):
- **Tasks:** `tasks` (the request and its outcome) and `task_events` (an
  append-only timeline). Each attempt is a row in `runs` with `task_id`, so
  tasks use the same queue, worker, runtime, tools, and approvals as
  conversations. No second queue.
- **State machine:** queued → running ⇄ awaiting_approval → completed /
  failed / cancelled / interrupted, enforced by conditional UPDATEs
  (`src/server/tasks/lifecycle.ts`). Completed is final.
- **Durable queue:** claims with `FOR UPDATE SKIP LOCKED` and only when a
  retry's `not_before` has passed; worker ID and heartbeat lease on each run;
  configurable concurrency (`SOLAS_WORKER_CONCURRENCY`, 1 by default, at
  most 3).
- **Recovery:** a lost attempt is retried once, after a backoff, only when
  that is safe (no tool with side effects ran, no approval pending);
  otherwise the task is "interrupted" for the owner. Usage limits, timeouts,
  and configuration errors are never retried automatically.
- **Cancellation** goes through the worker and is shown truthfully
  ("Cancelling…") until confirmed; **Retry** starts a new attempt.
- **UI:** Tasks list with search, status filters and counts (in the URL);
  New task form (idempotent submit); task page with result, live progress,
  approvals, attempts, tool activity, and timeline. Live updates by
  re-rendering from the database every second while active.
- **Tests:** Vitest 247, Playwright 38, and real runs with Claude: browser
  closed mid-run, worker killed mid-run (recovered as attempt 2), and Cancel
  then Retry.
- No new dependencies.

**M4C — Workspace writing and approvals you can trust** *(proposed)*
- **Writing tools:** create and edit text files in the agent's own workspace,
  always with approval and a before/after preview. Never outside the
  workspace, never deleting. Marked `sideEffects: true`, so the retry
  policy never repeats them.
- **Approvals:** a badge in the sidebar when something waits for you, and an
  agent-level audit view of every tool call.
- **Robustness:** a per-agent limit on tool calls per run. (Approvals that
  survive a worker restart need a resumable session; until then an
  interrupted attempt asks again on Retry, see ARCHITECTURE §5.8.)

**M4 — Runs you can inspect** *(proposed)*
A run history per agent and conversation: status, timing, tokens, errors.
An agent's page lists its conversations.

**M5 — MVP complete** *(proposed)*
Review against the MVP success criteria: keyboard-only, 375 px, both themes,
long conversations (context strategy re-evaluated), failure drills.

### Phase 2 — Controlled autonomy (still local)

**M6 / M7 — Tools and approvals** *(foundation done in M4A)*
Remaining: writing tools inside the workspace (with approval), more Solas
tools, approvals that survive a worker restart, and a per-agent audit view.
Shell stays disabled.

**M8 — Schedules** *(one-off tasks done in M4B)*
Schedules (cron-like) that create tasks, with run history, pause / resume, and
budgets per agent.

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
| **Team seat ownership** | Still open | This Mac's Claude Code is signed in to a Team plan in the "Xala team" organization. M3A runs on it (owner's decision, local only). Personal-project usage counts against that seat and falls under that organization's commercial agreement and admin policies, including any extra-usage setting. Confirm with the org admin, or move to a personal plan / API key. |
| Runtime isolation | ✓ M3A | Default config directory (no second sign-in), isolated per run: `settingSources: []`, `strictMcpConfig`, no auto memory, no claude.ai connectors, `persistSession: false`, empty working directory outside the repo. A dedicated `CLAUDE_CONFIG_DIR` stays an option |
| Local PostgreSQL install method | ✓ M2A | Docker Compose with `postgres:18-alpine` (same image works on a Linux VPS) |
| Validation library | ✓ M2A | Zod 4 |
| Agent deletion once history exists | ✓ M3A | Cascade: deleting an agent deletes its conversations (the dialog says so). Archive can come later |
| How the worker runs TypeScript | ✓ M3A | `tsx` (already a dev dependency), like the agents CLI |
| Conversation continuity | ✓ M3B | Rebuild bounded history from PostgreSQL (last 20 messages / 60,000 characters). SDK session resume rejected: transcripts would live in `~/.claude`, outside Solas's database and its delete button. Revisit with summaries if long conversations need more memory |
| Test tooling | ✓ M2A, M3B | Vitest (unit + integration); Playwright browser tests since M3B (`npm run test:e2e`) |
| Background task execution | ✓ M4B | Tasks are runs with `task_id`: one queue, one worker, one runtime. Retries are automatic only after a lost worker or provider outage, once, when safe; otherwise "interrupted" for the owner |
| Live updates for tasks | ✓ M4B | Re-render from PostgreSQL every second while active (`router.refresh()`); SSE from `task_events` stays the upgrade path |
| Resuming an approval after a worker restart | Later | Needs a resumable provider session; SDK resume was rejected in M3B (transcripts outside PostgreSQL). Until then: interrupted + Retry asks again |
| Hosted runtime credentials | M10 | Re-check terms; API key by default for hosted use. Unattended tasks on a server make this decision stricter, not looser |
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
