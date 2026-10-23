# Solas — Architecture

This document explains how Solas fits together, written for a developer who is
learning. It describes the **target** architecture and says in which milestone
each part arrives. Anything not yet built is a plan, not a promise.

## 1. The big picture

Solas has two processes and one database.

```
 ┌──────────── Owner's browser (laptop or phone) ────────────┐
 │  React UI: pages rendered on the server, small interactive │
 │  client components, live run output via Server-Sent Events │
 └───────────────▲──────────────────────────┬────────────────┘
                 │ HTML, RSC, SSE           │ forms, fetch
                 │                          ▼
 ┌──────────────── Web process: Next.js ─────────────────────┐
 │  src/app/      pages, layouts, Server Actions, routes     │
 │  src/server/   domain logic + data access (server-only)   │
 │  Never runs agents. Never holds a Claude credential.      │
 └───────────────┬───────────────────────────▲───────────────┘
                 │ SQL: write agents,        │ SQL: read runs,
                 │ messages, queued runs,    │ events, approvals
                 │ approval decisions        │
                 ▼                           │
 ┌──────────────────────── PostgreSQL ───────┴───────────────┐
 │  agents · conversations · messages · runs · run_events    │
 │  approvals · tasks · schedules · sessions                 │
 └───────────────▲───────────────────────────┬───────────────┘
                 │ SQL: claim runs,          │
                 │ write events              ▼
 ┌──────────────── Worker process: Node.js ──────────────────┐
 │  src/worker/   job loop, scheduler, run supervisor        │
 │  src/server/   same domain code as the web process        │
 │  AgentRuntime ──▶ Claude Agent SDK adapter                │
 │                     └─ unmodified Claude Code binary      │
 │                          └─ owner's own login ──▶ Anthropic
 │  No network port. Talks only to PostgreSQL and Anthropic. │
 └───────────────────────────────────────────────────────────┘
```

Four ideas to hold on to:

1. **The database is the meeting point.** The web process and the worker never
   call each other. The web writes a "queued run"; the worker picks it up and
   writes events. Either can restart without the other noticing.
2. **The worker does the agent work.** Agent runs can take minutes, need a
   subprocess, and must survive the browser closing. A web request is the wrong
   place for that.
3. **The model layer is an interface.** The worker talks to `AgentRuntime`.
   The Claude Agent SDK is one adapter; an API-key adapter can be added later.
4. **Credentials stay with Anthropic's tooling.** Claude Code manages its own
   sign-in. Solas code never reads, copies, or stores Claude credentials.

## 2. Components and how they fit

| Component | What it is | Lives in | Milestone |
| --- | --- | --- | --- |
| **Frontend** | Next.js App Router UI. Server Components by default, Client Components only for interaction | `src/app/`, `src/components/` | M1 |
| **Backend API** | Server Actions for mutations (create agent, send message, approve). Route Handlers for streaming (SSE) and anything non-form. No separate API server | `src/app/**/actions.ts`, `src/app/api/` | M2+ |
| **Domain + data access** | Plain TypeScript functions that validate input, check authorization, and read/write the database. Shared by web and worker | `src/server/` | M2+ |
| **Persistent storage** | PostgreSQL with Drizzle ORM and versioned migrations | `src/server/db/` | M2 |
| **Agent management** | CRUD for agent definitions: name, role, instructions, model, tool profile, budgets | `src/server/agents/` | M2 |
| **Agent execution layer** | `AgentRuntime` interface + adapters. Turns "agent + input" into a stream of Solas `RunEvent`s | `src/server/runtime/` | M3 |
| **Background worker** | Separate Node process: claims queued runs, supervises them, fires schedules, recovers after crashes | `src/worker/` | M4 |
| **Conversations** | Per-agent threads. Each user message creates a run; the agent's reply is stored as messages and run events | `src/server/conversations/` | M5 |
| **Tools and permissions** | Tool profiles, workspace directories, a policy hook that enforces them | `src/server/tools/`, `src/server/policy/` | M6 |
| **Approvals** | Sensitive tool calls pause a run until the owner decides | `src/server/approvals/` | M7 |
| **Tasks and schedules** | One-off assignments and recurring triggers that create runs | `src/server/tasks/` | M8 |
| **Authentication** | Single owner. Login page, database sessions, checks in every data-access function | `src/server/auth/`, `src/proxy.ts` | M9 |
| **Deployment** | One VPS: web, worker, PostgreSQL, reverse proxy; private network access | `deploy/` (later) | M10 |

## 3. Key Next.js concepts used here

This project uses Next.js 16.4, which differs from most tutorials. Always read
the bundled docs in `node_modules/next/dist/docs/` before using an API.

| Concept | Meaning | Use in Solas |
| --- | --- | --- |
| App Router | Folders in `src/app/` are routes. `page.tsx` renders a URL; `layout.tsx` wraps its children | All pages |
| Server Components | Default. Run only on the server; can read the database directly | Lists, detail pages, history |
| Client Components (`'use client'`) | Also run in the browser; can use state and events | Theme switcher, composer, live run view |
| Server Actions (`'use server'`) | Server functions called from forms; built-in origin checks | Create/edit agent, send message, approve |
| Route Handlers (`route.ts`) | Plain HTTP endpoints returning a `Response` | SSE stream of run events |
| Proxy (`src/proxy.ts`) | Runs before requests; formerly called Middleware | Optimistic login redirect (M9) |
| Cache Components | Enabled in `next.config.ts`. Pages prerender into a static shell; per-request data must sit inside `<Suspense>` or be explicitly cached with `'use cache'` | Every database-backed page |
| Route groups `(name)` | Folders that group routes without changing the URL | `(app)` for the shell, `(auth)` for login |

**Why SSE for live output?** The worker writes events to the database. A Route
Handler streams new events for one run to the browser as `text/event-stream`.
If the connection drops, the browser reconnects with the last event ID it saw,
so nothing is lost. Nothing in the browser depends on the run's process being
alive; the stream is just a view of the database.

## 4. Data model (target)

Introduced in the milestone shown. Columns are indicative.

```
agents (M2A, built — see §4a)
  id, name, description, role, instructions, provider_id, model_id,
  enabled, created_at, updated_at
  later, in their own tables or columns: tool profile, workspace,
  execution settings (budgets), archived_at

conversations (M5)
  id, agent_id → agents, title, runtime_session_id (nullable),
  archived_at, created_at, updated_at

messages (M5)
  id, conversation_id → conversations, role ('user' | 'agent'),
  content (text / jsonb), run_id → runs (nullable), created_at

runs (M4)
  id, agent_id, conversation_id (nullable), task_id (nullable),
  status ('queued' | 'running' | 'awaiting_approval' | 'succeeded' |
          'failed' | 'cancelled'),
  input, runtime ('claude-agent-sdk' | …), error_code, error_message,
  usage (jsonb), claimed_by, heartbeat_at,
  queued_at, started_at, finished_at

run_events (M4)
  id (sequential), run_id → runs, type, payload (jsonb), created_at

approvals (M7)
  id, run_id, tool_name, tool_input (jsonb), reason,
  status ('pending' | 'approved' | 'denied' | 'expired'),
  decided_at, decision_note

tasks (M8)        id, agent_id, title, instructions, status, result_run_id, …
schedules (M8)    id, agent_id, task template, cron, timezone, enabled, next_run_at, …
sessions (M9)     id, token_hash, expires_at, user_agent, created_at
```

Design choices:

- **`run_events` is append-only.** It is the audit log, the source for live
  streaming, and the history of what an agent did. Events are never edited.
- **`runs` is the queue.** No separate queue service: the worker claims the
  oldest `queued` row with `SELECT … FOR UPDATE SKIP LOCKED`, sets `running`,
  and updates `heartbeat_at` while working. A run whose heartbeat goes stale
  (the worker crashed) is marked failed or re-queued on worker start.
- **Solas stores its own event format,** not the SDK's raw messages. That keeps
  the UI and database independent of the runtime (see §5.2).

## 4a. The agent backend (built in M2A)

### How the database works

- **PostgreSQL 18** runs locally in Docker (`compose.yaml`). It listens only
  on `127.0.0.1:5432`, and its data lives in the named volume
  `solas-postgres`, so it survives container restarts. On a VPS the same image
  (or the same major version from apt) is used.
- **The schema is TypeScript:** `src/server/db/schema.ts`. When it changes,
  `npm run db:generate` asks drizzle-kit to compare it with the last snapshot
  and write a SQL migration to `drizzle/`. `npm run db:migrate` applies
  pending migrations and records them in `drizzle.__drizzle_migrations`.
  Migrations are committed, so every machine builds the same database.
- **Connections:** `src/server/db/client.ts` creates one small pool per process
  (postgres.js, 5 connections, 5-second connect timeout). In development the
  pool is cached on `globalThis` so hot reloads don't leak connections.
- **Configuration:** `DATABASE_URL` comes from `.env.local`, which is
  git-ignored. `.env.example` documents the variables with placeholders.

### How an agent is represented

One row in `agents`:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` | Primary key, `gen_random_uuid()`. Stable and never reused |
| `name` | `text` | Required, 1–80 chars. Unique regardless of case (`lower(name)` index) |
| `description` | `text` | ≤ 500 chars, default `''` |
| `role` | `text` | ≤ 120 chars, default `''`, e.g. "Finds and summarizes sources" |
| `instructions` | `text` | The system instructions, ≤ 20,000 chars, default `''` |
| `provider_id`, `model_id` | `text`, nullable | Both NULL means "not configured". A check constraint requires both or neither |
| `enabled` | `boolean` | Default `true`. The owner's switch for whether this agent may run |
| `created_at`, `updated_at` | `timestamptz` | Set from the database clock on insert and on every update |

Two things are deliberately **not** stored:
- **Whether a provider/model is usable.** The registry decides that in code.
- **Readiness.** `getAgentReadiness()` computes it on demand as `ready`,
  `disabled`, or `unconfigured` with a reason.

Future features attach through new tables keyed by `agents.id`, rather than by
widening this one.

### How the backend handles agent configuration

```
 caller (Server Action, Server Component, test, CLI, later the worker)
   │
   ├─ requireOwner()             only in the web app: fail-closed owner guard
   │
   ▼
 agent service                   src/server/agents/service.ts
   ├─ validate input (Zod)       src/server/agents/validation.ts — strict objects,
   │                             trimmed strings, length limits, UUID ids
   ├─ check provider/model       src/server/providers/registry.ts
   ├─ query with Drizzle         src/server/db/
   └─ map failures               src/server/agents/errors.ts → AgentServiceError
                                 (validation_failed | not_found | name_taken |
                                  database_unavailable | unexpected)
```

- **Service methods:** `list()`, `get(id)`, `create(input)`,
  `update(id, changes)`, `remove(id)`, `setEnabled(id, enabled)`.
- **Inputs are `unknown`:** the service never trusts its caller.
- **No mass assignment:** strict schemas reject unknown fields such as `id` or
  `createdAt`.
- **Dependencies are passed in:** `createAgentService({ db, providers })`
  makes the service testable against a test database and a fake provider
  registry. `getAgentService()` wires up the real ones.
- **Defense in depth:** the unique index and check constraints mean the
  database rejects bad data even if a code path skipped validation.
- **Database errors are translated.** `classifyDatabaseError()` walks the error
  chain (Drizzle wraps driver errors) and maps codes:
  - `23505` unique violation → `name_taken`
  - `23514` check violation → `validation_failed`
  - connection and authentication failures → `database_unavailable`, with a
    hint to run `npm run db:up`
  - anything else → `unexpected`; details are logged on the server and never
    sent to the browser.

### Provider configuration

`src/server/providers/registry.ts` lists the execution providers Solas knows
about. Each one has a status (`available` / `unconfigured`) and a list of
models. Today it contains only `claude-agent-sdk`, marked `unconfigured`,
because nothing has verified that agents can run through it. M3 changes that.

Consequences:
- A provider/model pair is accepted only if the provider is `available` and
  offers the model.
- Until then, the only valid selection is "not configured".
- Agent identities are never hardcoded: the execution engine will read agents
  from the database and look the provider up here.

### How the frontend will use it (M2B)

| Need | Mechanism |
| --- | --- |
| Show agents | Server Component: `await requireOwner()`, then `await getAgentService().list()`, inside `<Suspense>` (Cache Components) |
| Create / edit / enable / delete | Client form calls the Server Actions in `src/app/(app)/agents/actions.ts` |
| Show errors | Actions return `ActionResult`: `{ ok: true, data }` or `{ ok: false, error: { code, message, fieldErrors } }`. Forms show `fieldErrors` next to inputs |
| Fresh data after a change | Actions call `revalidatePath("/agents")` |
| Provider/model picker | The server passes `providerRegistry.list()` as plain data |

Server Actions are used instead of API routes because of how they are exposed:
- Next.js gives them built-in origin checks (CSRF protection).
- Only actions some component imports are exposed at all. The M2A build
  registers **0** actions, so nothing is reachable over HTTP until the UI uses
  them.

### The owner guard (until M9)

`requireOwner()` in `src/server/auth/owner.ts` fails closed. It allows a
request only when:
- `SOLAS_LOCAL_OWNER_MODE=true` is set, which is local only and never on a
  server; and
- the request's `Host` is `localhost`, `127.0.0.1`, or `[::1]`. That also
  blocks DNS-rebinding attacks.

Together with the dev and start servers binding to `127.0.0.1`, this keeps
every mutation on the owner's machine. M9 replaces the body with a real
session check, and callers don't change.

## 5. The agent execution layer

### 5.1 How agents reach Claude: the decision

Verified against Anthropic's documentation on 2026-10-23:

- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview): the SDK "runs the
  Claude Code binary" and is governed by the Commercial Terms. Note: "Unless
  previously approved, Anthropic does not allow third party developers to offer
  claude.ai login or rate limits for their products, including agents built on
  the Claude Agent SDK."
- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance): Team plans fall
  under the Commercial Terms. Subscription OAuth "is designed to support
  ordinary use of Claude Code and other native Anthropic applications."
  Developers building products or services with the Agent SDK "should use API
  key authentication". The restrictions do not prevent "an end user from
  signing in to the unmodified Claude Code binary with their own Claude
  subscription". Advertised limits assume "ordinary, individual usage of
  Claude Code and the Agent SDK."
- [Authentication](https://code.claude.com/docs/en/authentication): Team plan users sign in with
  their claude.ai account. `claude setup-token` creates a one-year token for
  "CI pipelines, scripts, or other environments where interactive browser
  login isn't available".

What Solas does with that:

| Stage | Runtime | Credential | Rationale |
| --- | --- | --- | --- |
| Local prototype (M3–M8) | Claude Agent SDK adapter | The owner's own Claude Code sign-in on the Mac, done with `claude auth login` | Single owner, own subscription, unmodified binary, nothing offered to others |
| Hosted (M10) | Decided then | Default: API key from the Claude Console. Subscription only if current terms clearly allow it for this use | Hosted, always-on use is outside what Solas should assume |
| Ever multi-user | API key adapter | Each user's own key or the operator's key | Required by the terms |

Hard rules, enforced in code review:

- Solas never reads `~/.claude/.credentials.json`, the macOS Keychain entry,
  or any OAuth token. It never passes a subscription credential via HTTP, the
  database, or the UI.
- Solas never sets `CLAUDE_CODE_OAUTH_TOKEN` in code. If an owner chooses to
  use `claude setup-token` on their own server later, they do it themselves,
  in that server's environment.
- No modified Claude Code binary, no unofficial clients, no rate-limit
  workarounds. When a limit is hit, the run fails with a clear status.

### 5.2 The runtime interface

```ts
// Shape only — implemented in M3. Solas-owned types; no SDK types leak out.
interface AgentRuntime {
  readonly id: "claude-agent-sdk" | "anthropic-api";
  run(input: RunInput, control: RunControl): AsyncIterable<RunEvent>;
}

type RunInput = {
  agent: AgentDefinition;     // instructions, model, tool profile, budgets
  prompt: string;
  workspaceDir: string;       // the only directory the agent may touch
  resumeSessionId?: string;   // continuity, if the runtime supports it
};

type RunControl = {
  signal: AbortSignal;                                   // cancel / timeout
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>; // M7
};

type RunEvent =
  | { type: "status"; status: "started" | "thinking" | "working" }
  | { type: "text"; text: string }
  | { type: "tool_call"; tool: string; input: unknown }
  | { type: "tool_result"; tool: string; ok: boolean; summary: string }
  | { type: "approval_requested"; approvalId: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "completed"; sessionId?: string }
  | { type: "failed"; code: RunErrorCode; message: string };
```

Swapping runtimes means writing one new adapter that produces these events.

### 5.3 The Claude Agent SDK adapter: locked down by default

The SDK runs Claude Code's full agent loop, including powerful built-in tools
(file edits, shell). Solas starts from **nothing allowed** and opens up
deliberately:

| Control | Setting | Why |
| --- | --- | --- |
| Settings isolation | Explicit `settingSources` (none, or Solas-provided only); possibly a dedicated `CLAUDE_CONFIG_DIR` (decide in M3) | Agents must not inherit the owner's personal `~/.claude` settings, memory, skills, or MCP servers |
| Built-in tools | `disallowedTools` removes `Bash` and every tool not in the agent's profile | Removed tools are not even visible to the model |
| Permission mode | `default` or `dontAsk`; **never** `bypassPermissions` | Anything not explicitly allowed is denied or routed to approval |
| Working directory | `cwd` = the agent's workspace (outside the repo, under a Solas data directory) | File tools are scoped to it |
| Policy hook | A `PreToolUse` hook checks every call (tool allowlist, paths inside the workspace) | Hooks run first and a hook deny holds in every mode: defense in depth |
| Approvals | `canUseTool` callback → `RunControl.requestApproval` → `approvals` row → owner decides | Sensitive actions wait for a human (M7) |
| Budgets | Max turns, max wall-clock time, one concurrent run by default | Protects plan limits and the machine |
| Custom tools | Solas tools exposed through an in-process MCP server, each with a schema and risk level | Solas defines exactly what an agent can do (M6) |

Exact option names are verified against the SDK reference when M3 starts.

### 5.4 Tools and permissions model

Every agent has a **tool profile**:

| Profile | Allows | Approval |
| --- | --- | --- |
| `none` (default, MVP) | Conversation only | — |
| `read-workspace` | Read / search files in the agent's workspace | No |
| `write-workspace` | Plus create and edit files in the workspace | Configurable; default yes |
| Custom Solas tools | Specific tools such as "save note" or "fetch allowed URL" | Per tool, by risk level |

Never offered to agents: unrestricted shell, arbitrary code execution,
arbitrary filesystem paths, arbitrary network access. If code execution is
ever added, it runs in an isolated sandbox with its own threat model.

Tool output is **untrusted**. It can contain text that tries to steer the
agent (prompt injection). Safety comes from least privilege and approvals,
not from trusting the model to ignore it.

## 6. Request flows

### 6.1 Sending a message (M5)

```
Browser                Web (Next.js)                 PostgreSQL            Worker
  │ submit message ──▶ Server Action
  │                    ├ (M9) check owner session
  │                    ├ validate input
  │                    ├ insert message ───────────▶ messages
  │                    └ insert run (queued) ──────▶ runs
  │ ◀── redirect/refresh
  │ open SSE ────────▶ GET /api/runs/:id/events
  │                    └ stream new run_events ◀──── run_events ◀── write events
  │                                                   runs ───────▶ claim (SKIP LOCKED)
  │                                                                  runtime.run(…)
  │ ◀── text / status events, live                                   ├ events → run_events
  │                                                                  └ final → messages, runs
  │ (browser may close at any point; the run continues)
```

### 6.2 Approval (M7)

```
Worker: agent requests a sensitive tool
  → canUseTool → requestApproval() → insert approvals(pending), run → awaiting_approval
Browser: owner sees the approval card (SSE / page load) → Approve or Deny (Server Action)
  → approvals row updated
Worker: notices the decision (polling or LISTEN/NOTIFY) → resolves the promise
  → the SDK continues or receives a denial → run resumes → status running
Timeouts: an approval that is not decided in time expires and is treated as denied.
```

The first version keeps the run process waiting while it asks. Making
approvals survive a worker restart (resuming the session afterwards) is a
later refinement.

### 6.3 Scheduled task (M8)

```
Worker scheduler tick → schedules where next_run_at <= now and enabled
  → insert run (queued) with the task's instructions → advance next_run_at
  → normal run flow; result visible under Tasks
```

## 7. Security model

| Concern | Approach |
| --- | --- |
| Claude credentials | Managed only by Claude Code's official sign-in. Never read, stored, or transmitted by Solas |
| Other secrets | `.env.local` / server environment only; `.env*` is git-ignored; never `NEXT_PUBLIC_` |
| Server/client boundary | `import 'server-only'` in `src/server/`; pass only the fields the UI needs |
| Agent execution | Only in the worker; no network listener; least-privilege tool profiles; policy hook; approvals |
| Working directories | One workspace per agent under a Solas data directory; never the repo or home directory |
| Shell | No shell tool for agents; no endpoint anywhere that runs commands |
| Network exposure (dev) | `npm run dev` / `npm start` bind to `127.0.0.1` (since M2A); PostgreSQL is published on `127.0.0.1` only |
| Owner guard (until M9) | `requireOwner()`: fail-closed; local owner mode + loopback `Host` (§4a) |
| Database input | Zod validation in the service; strict objects; unique index and check constraints in the database |
| Authentication | Single owner (M9) before any network exposure; checks in the data layer, not only in Proxy |
| Mutations | Server Actions (origin-checked) and Route Handlers (validate `Origin` and body) |
| Abuse and cost | Budgets per run, one concurrent run by default, rate limits (M9) |
| Deployment | Security review checklist and owner approval before M10; private access preferred |

## 8. Folder structure (target)

Folders appear when a milestone needs them.

```
src/
├─ app/                       web: routes, layouts, Server Actions, Route Handlers
│  ├─ (app)/                  the authenticated shell
│  │  ├─ page.tsx             Overview
│  │  ├─ agents/ …            list, new, [agentId]
│  │  ├─ conversations/ …     list, [conversationId]
│  │  ├─ tasks/ …
│  │  ├─ automations/ …       schedules (M8)
│  │  ├─ loading.tsx          skeleton shown while a page loads
│  │  └─ settings/
│  ├─ (auth)/login/           (M9)
│  └─ api/runs/[runId]/events/route.ts   SSE (M5)
├─ components/
│  ├─ ui/                     primitives: button, input, dialog, badge, kbd, skeleton, …
│  ├─ shell/                  sidebar, top bar, breadcrumbs, mobile drawer, command menu
│  ├─ preferences/            theme + sidebar stores, theme watcher, theme selectors
│  └─ icons.tsx               hand-drawn icon set
├─ lib/                       client-safe helpers (no secrets, no DB)
├─ server/                    server-only domain code, shared by web and worker
│  ├─ db/                     schema, client (pool), error classification   (M2A)
│  ├─ agents/                 service, validation, errors                   (M2A)
│  ├─ providers/              provider registry, readiness                  (M2A)
│  ├─ auth/                   owner guard (M2A), sessions (M9)
│  ├─ actions/                ActionResult + error mapping for Server Actions (M2A)
│  ├─ conversations/  runs/  approvals/  tasks/
│  ├─ runtime/                AgentRuntime, RunEvent, adapters/claude-agent-sdk.ts
│  └─ policy/  tools/
├─ test/                      Vitest global setup (test database)           (M2A)
├─ worker/                    worker entry point, job loop, scheduler
└─ proxy.ts                   (M9)

drizzle/                      generated SQL migrations (committed)          (M2A)
scripts/agents.mts            dev-only CLI for the agent backend            (M2A)
compose.yaml                  local PostgreSQL                              (M2A)
drizzle.config.ts, vitest.config.mts, .env.example
```

Rules: `src/lib/` never imports `src/server/`. `src/app/` never imports
`src/worker/`, and `src/worker/` never imports `src/app/`.

## 9. Deployment (M10, later)

```
Owner's devices ──(private network, e.g. Tailscale)──▶ Hetzner VPS
                                                        ├─ reverse proxy (TLS) ─▶ web (Next.js)
                                                        ├─ worker (no ports)
                                                        └─ PostgreSQL (local only) + backups
```

- Each process is its own service and restarts on failure.
- The reverse proxy must not buffer SSE responses.
- The firewall allows only SSH (restricted) and the private network.
- Backups are verified by restoring them.
- Nothing is provisioned before the owner approves the cost.

## 10. Testing strategy

| Level | Tool | When |
| --- | --- | --- |
| Static | ESLint, `tsc --noEmit`, `next build` | Every milestone |
| Unit | Vitest (since M2A) | Pure logic: validation, provider rules, host checks, error mapping |
| Integration | Vitest + `solas_test` database (since M2A) | Agent service CRUD, constraints, persistence, database-down handling |
| Runtime | A fake `AgentRuntime` that emits scripted events | Worker and UI tests without calling Claude |
| End-to-end | Playwright (to be added) | Key flows once the MVP is stable |
| Manual | Per-milestone checklist | Both themes, keyboard only, 375px, real agent run |

`src/test/global-setup.ts` creates `solas_test` if needed and applies
migrations. It refuses to run against a database whose name doesn't end in
`_test`, because the tests delete rows.

Automated tests never call the real Claude service. That keeps them free,
fast, deterministic, and off the subscription limits.
