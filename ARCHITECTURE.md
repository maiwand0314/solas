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
| **Agent execution layer** | `AgentRuntime` interface + adapters. Turns "agent + input" into a Solas `RunResult` (events and streaming in M3B) | `src/server/runtime/`, `src/server/runs/` | M3A |
| **Background worker** | Separate Node process: claims pending runs (up to a configurable number at once), supervises them, recovers after crashes (schedules in M8) | `src/worker/`, `src/server/runs/worker-loop.ts` | M3A, M4B |
| **Conversations** | Per-agent threads. Each user message creates a run; the agent's reply is stored as a message | `src/server/conversations/` | M3A |
| **Tools and permissions** | Tool registry, per-agent permissions, workspaces, and the enforcement layer every call goes through | `src/server/tools/` | M4A |
| **Approvals** | Tool calls that need approval wait for the owner's decision in the conversation | `src/server/tools/invoker.ts`, `src/server/conversations/` | M4A |
| **Tasks** | One-off assignments the worker runs in the background; each attempt is a run. State machine, retry policy, timeline | `src/server/tasks/` | M4B |
| **Schedules** | Recurring triggers that create tasks | `src/server/tasks/` (later) | M8 |
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

**How live output reaches the browser (M3B).** The worker saves the reply
written so far on the run row (at most every 300 ms), and the conversation
view fetches the run's state twice a second while it runs. Nothing in the
browser depends on the run's process: the view is just a reading of the
database, so a reload or a closed tab loses nothing. Server-Sent Events from
an append-only `run_events` table remain the upgrade path if polling ever
feels slow or tool calls need to be shown step by step.

## 4. Data model (target)

Introduced in the milestone shown. Columns are indicative.

```
agents (M2A, built — see §4a)
  id, name, description, role, instructions, provider_id, model_id,
  enabled, created_at, updated_at
  later, in their own tables or columns: tool profile, workspace,
  execution settings (budgets), archived_at

conversations (M3A, built)
  id, agent_id → agents (cascade), title, created_at, updated_at
  no provider session reference: context is rebuilt from messages (§5.5)
  later: archived_at

messages (M3A, built)
  id, conversation_id → conversations (cascade), role ('user' | 'assistant'),
  content (text), run_id → runs (nullable; set on assistant messages),
  client_message_id (M3B; unique, chosen by the browser per send),
  created_at
  a message is only stored when it is final, so it needs no status of its own;
  the status lives on the run

runs (M3A, built; extended in M4B)
  id, agent_id → agents,
  conversation_id → conversations + user_message_id → messages
    (a conversation run: "answer this message"), or
  task_id → tasks (M4B; a task run: one attempt at the task);
    a check constraint requires exactly one of the two
  attempt (M4B; 1, 2, … per task), worker_id (M4B; who claimed it),
  not_before (M4B; a scheduled retry isn't claimed before this),
  status ('pending' | 'running' | 'completed' | 'failed' | 'cancelled'),
  model_id (recorded at start), error_code, error_message,
  cancel_requested_at, input_tokens, output_tokens,
  partial_output (M3B; the text so far, kept on a stopped or failed run),
  heartbeat_at (M3B; refreshed every second by the worker running it: the lease),
  created_at, started_at, finished_at
  unique: one pending/running run per conversation, and per task

tasks (M4B, built — see §5.8)
  id, agent_id → agents (cascade), title, instructions,
  status ('queued' | 'running' | 'awaiting_approval' | 'completed' |
          'failed' | 'cancelled' | 'interrupted'),
  result, error_code, error_message, cancel_requested_at,
  auto_retries_left, client_request_id (unique; idempotent create),
  created_at, updated_at, started_at, finished_at

task_events (M4B, built)
  id (sequential identity), task_id → tasks (cascade), run_id → runs,
  type, message (written by Solas), data (jsonb: ids and codes only), created_at

agent_tool_permissions (M4A, built)
  agent_id → agents (cascade), tool_id, mode ('allow' | 'ask'), created_at
  primary key (agent_id, tool_id); no row = tool off

tool_calls (M4A, built; also the approval record)
  id, run_id → runs (cascade), tool_id, input (jsonb, validated),
  input_summary, status ('awaiting_approval' | 'approved' | 'rejected' |
  'expired' | 'running' | 'succeeded' | 'failed' | 'denied' | 'cancelled'),
  requires_approval, approval_expires_at, decided_at,
  result_summary, error_message, created_at, finished_at

schedules (M8)    id, agent_id, task template, cron, timezone, enabled, next_run_at, …
sessions (M9)     id, token_hash, expires_at, user_agent, created_at
```

Design choices:

- **`task_events` is append-only.** It is a task's audit log and timeline.
  Events are never edited, and they hold Solas's own sentences plus IDs and
  codes: no model output, no tool output, no credentials. (Conversation runs
  have no event table; their tool activity lives in `tool_calls`.)
- **`runs` is the queue.** No separate queue service: the worker claims the
  oldest `pending` row with `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP
  LOCKED LIMIT 1)` and sets `running`. Note the `=`: with `IN`, PostgreSQL
  may re-run the subquery per row and claim several runs at once (found by a
  test in M3A). A running run carries a heartbeat; recovery is described in
  §5.6.
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
   ├─ validate input (Zod)       src/lib/agents/validation.ts — strict objects,
   │                             trimmed strings, length limits, UUID ids
   │                             (shared: the form runs the same rules first)
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
models. Since M3A it contains `claude-agent-sdk` (label "Claude"), available,
with full model IDs verified against the owner's account on 2026-10-24:
`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`. Model IDs are
passed to Claude unchanged; the adapter refuses a session that starts any
other model, so a model is never silently substituted.

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

Re-verified on 2026-10-24 (M3A): the same statements still apply, and the
owner chose to run M3A on the Team subscription, locally only. The account
probe reported `subscriptionType: "Claude Team"` with no API key source.

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

### 5.2 The runtime interface (built in M3A)

`src/server/runtime/types.ts`. Solas-owned types; no SDK type leaves the adapter.

```ts
interface AgentRuntime {
  readonly providerId: string;                 // "claude-agent-sdk"
  run(input: RunInput, signal: AbortSignal, onProgress?): Promise<RunResult>;  // never throws
}

type RunInput = { systemPrompt: string; prompt: string; model: string; tools: RuntimeTool[] };
type RuntimeTool = { name; description; inputShape /* Zod */; invoke(input): Promise<{ text; isError }> };

type RunResult =
  | { status: "completed"; text: string; usage: { inputTokens; outputTokens } }
  | { status: "failed"; code: RunErrorCode; message: string; retryAt?: Date }
  | { status: "aborted" };   // the caller knows whether that was a timeout or Stop
```

`RunErrorCode` is a fixed list (`not_signed_in`, `usage_limit`,
`paid_credential_refused`, `model_unavailable`, `provider_unavailable`, …).
Messages shown to the owner are written by Solas from these codes; provider
text never reaches the UI, so nothing internal can leak.

`run` also takes an optional `onProgress(textSoFar)` callback (M3B). The
Claude adapter calls it for each real text delta from the API; the final
text is always the one in the result. A provider that can't stream simply
never calls it.

Adding a provider means: one adapter implementing `AgentRuntime`, one entry
in the registry, and passing it to the worker. Nothing else changes.

### 5.3 The Claude Agent SDK adapter: locked down by default

`src/server/runtime/claude-agent-sdk.ts`. The SDK starts the unmodified
Claude Code binary bundled with it; that binary uses the owner's own sign-in.

| Control | Setting (as built) | Why |
| --- | --- | --- |
| System prompt | `systemPrompt: <agent.instructions>` (a plain string) | Replaces Claude Code's own prompt entirely: the agent is exactly its stored instructions |
| Built-in tools | `tools: []`; `allowedTools` lists only the agent's Solas tools (M4A) | No built-in tool (shell, files, web) exists in the session |
| Permission mode | `dontAsk`, set explicitly | Anything not pre-approved is denied. If omitted, Claude Code may start in `auto`. **Never** `bypassPermissions` |
| Policy hook | `PreToolUse` hook that denies every call except the agent's Solas tools | Hooks run first and hold in every mode: defense in depth |
| Settings isolation | `settingSources: []`, `strictMcpConfig: true`, `mcpServers: {}` | Ignores the owner's `~/.claude` settings, CLAUDE.md, skills, plugins, and MCP servers |
| Environment | Allowlist only: `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `TMPDIR`; plus `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`, `CLAUDE_AGENT_SDK_CLIENT_APP=solas/0.1.0` | No `DATABASE_URL`, no passwords, and no `ANTHROPIC_*` / `CLAUDE_CODE_USE_*` that could switch to a paid API key or another provider |
| Working directory | `$TMPDIR/solas-runtime`, created empty, refused if inside the repo | Nothing for the agent to find |
| Sessions | `persistSession: false` | No transcripts written to `~/.claude/projects`; Solas keeps history in PostgreSQL |
| Budgets | `maxTurns: 1`, `maxBudgetUsd: 1`, 3-minute timeout, one run at a time | Protects plan limits and the machine |
| Streaming | `includePartialMessages: true`; only `text_delta` events are passed on (thinking is skipped) | Real text as it is written, for the live view |
| Solas tools (M4A) | Permitted tools served by an in-process MCP server (`createSdkMcpServer`); `allowedTools` and the hook admit exactly those; `maxTurns: 10` when tools exist | The official mechanism; handlers are Solas's own enforcement code (§5.7) |
| **Verified at start** | The session's `init` message must report `apiKeySource: "none"`, zero tools, zero MCP servers, `dontAsk`, and the requested model, or the run stops | Settings can also come from places Solas doesn't control (managed policy, a Console login). Solas checks the result instead of trusting its options |
| Usage limits | A `rate_limit_event` that is `rejected`, or that shows paid extra usage (`isUsingOverage`), stops the run as `usage_limit` | No silent fall-through to paid usage |

Smoke test, 2026-10-24: `apiKeySource: "none"`, `tools: 0`, `mcpServers: 0`,
`permissionMode: "dontAsk"`, `model: "claude-opus-5-5"`, Claude Code 2.1.310.

### 5.4 How a message becomes a reply (M3A, streaming since M3B)

```
Browser                Web (Next.js)                       PostgreSQL         Worker
 │ Enter ──────────▶ sendMessage (Server Action)
 │                   ├ requireOwner()
 │                   ├ validate (Zod, shared with the composer)
 │                   ├ load agent; enabled? model in registry?
 │                   └ one transaction: conversation, user message,
 │                     run (pending) ───────────────────────▶ runs
 │ ◀── { conversationId, runId }
 │ poll getRunState (1 s pending, 0.5 s running) ───────────▶ runs ◀── claim (= subquery, SKIP LOCKED)
 │   "Waiting for the worker…" / text so far + "… is writing · 0:12" ├ load agent again (may have changed)
 │                                                                   ├ prompt = recent history + message
 │                                                                   ├ runtime.run({ instructions, prompt, model }, onProgress)
 │                                                                   │   onProgress → runs.partial_output (≤ every 300 ms)
 │                                                                   │   heartbeat + Stop check every 1 s; timeout 3 min
 │                                                                   └ one transaction: assistant message,
 │                                                                     run completed (or failed / cancelled)
 │ terminal status → router.refresh() → server renders the saved reply
```

The browser can close at any point; the run continues and the reply is
there on the next visit. Stop on a pending run cancels it at once; on a
running run it sets `cancel_requested_at`, and the worker aborts within a
second.

### 5.5 Conversation context (M3B)

**Decision: PostgreSQL is the only memory.** Each run is a fresh Claude
session. The worker rebuilds the conversation from the `messages` table and
sends it with the new message (`src/server/runs/prompt.ts`):

```
Earlier messages in this conversation, oldest first:

<user>
My project uses Next.js and PostgreSQL.
</user>
<assistant>
Understood. …
</assistant>

Reply to the user's new message:

Which database library would you recommend for this project?
```

- **Bounded:** at most the last 20 messages and 60,000 characters; the oldest
  are dropped first. Context never grows without limit.
- **Isolated:** only messages of the run's own conversation are read, and the
  agent is the conversation's agent. Tests check that two conversations, and
  two agents, never see each other's messages.
- **Honest:** only saved messages count. The partial text of a stopped or
  failed reply is shown, but never used as context.
- **Instructions:** the agent row is read when each run starts. An edit in
  Agent Builder applies from the **next message** in every conversation,
  including old ones. A reply already being written keeps the instructions
  it started with.

**Why not the SDK's session resume?** `resume: sessionId` replays a
transcript that Claude Code stores as a file under `~/.claude/projects/`. That
would put conversation content outside Solas's database (and outside its
delete button), tie context to one machine's Claude Code folder, and need
`persistSession: true`. Rebuilding from PostgreSQL keeps one source of truth
that works the same after a restart, a move to a server, or a provider change.
The cost: earlier turns are sent again on every message (more input tokens),
and very old turns of a long conversation are forgotten.

### 5.6 Run lifecycle and recovery (M3B)

```
            Stop                 claimed by a worker
 pending ─────────▶ cancelled    pending ──────────────▶ running
                                                         │  heartbeat every 1 s
                                                         ├─▶ completed  (reply saved as a message)
                                                         ├─▶ failed     (provider error, timeout, shutdown,
                                                         │               or heartbeat stale for 30 s)
                                                         └─▶ cancelled  (Stop, or conversation deleted)
 failed / cancelled ── Retry (latest message only) ──▶ a new pending run for the same message
```

- **One run per conversation at a time.** A partial unique index allows only
  one pending or running run per conversation.
- **No duplicate messages.** The browser gives each message a
  `client_message_id`; sending it again returns the first result. This also
  covers two identical sends arriving at once.
- **Never executed twice.** Claiming uses `FOR UPDATE SKIP LOCKED`.
- **The browser doesn't matter.** Closing the tab cancels nothing: the run
  belongs to the database and the worker.
- **Worker restarts.**
  - Pending runs simply wait and run.
  - A run whose heartbeat is older than 30 s has lost its worker. On start,
    and every 30 s, a worker marks such runs `failed` (`worker_stopped`).
  - A live worker's runs are never touched, so a second worker is safe.
- **No blind re-runs.** An interrupted reply is not repeated automatically:
  Claude may already have done (and counted) the work, and Solas can't verify
  a result it never received. The owner decides with Retry. (A task attempt
  follows the task retry policy instead: one automatic retry when that is
  provably safe, see §5.8.)

### 5.7 Tools and permissions (built in M4A)

**The tool registry** (`src/server/tools/registry.ts`) is the complete list
of tools Solas can run. Each tool is a `ToolDefinition` in backend code:

| Field | Purpose |
| --- | --- |
| `id` | Unique, stable; also the name the model calls it by |
| `name`, `description` | For the owner and the model |
| `input`, `output` | Zod schemas: arguments are validated, and the result must match its contract before the model sees it |
| `risk`, `capability` | Shown to the owner (low/medium/high; what it may touch) |
| `sideEffects` | Whether it changes anything (M4B). A lost task attempt that may have run such a tool is never repeated automatically |
| `approval`, `defaultMode` | `optional` (owner picks "Run automatically" or "Ask me first") or `required` (always asks) |
| `timeoutMs`, `maxOutputChars` | Limits per call |
| `summarizeInput/Output` | One-line summaries for the activity log |
| `execute` | The handler; gets only the validated input, the agent's workspace, and an abort signal |

The tools in M4A:

| Tool | Does | Risk | Default |
| --- | --- | --- | --- |
| `current_time` | Date and time in a validated IANA time zone | Low | Runs automatically |
| `list_workspace_files` | Lists one folder of the agent's workspace | Low | Runs automatically |
| `read_workspace_file` | Reads one UTF-8 text file (≤ 256 KB) from the workspace | Medium | Runs automatically (owner's choice; "Ask me first" per agent) |

**Workspaces.** One folder per agent: `~/Solas/workspaces/<agent-id>`
(`SOLAS_WORKSPACES_DIR` overrides the root). The root must be a dedicated
folder: not `/`, not the home folder, not inside or around the Solas app.
`resolveWorkspacePath` refuses:
- absolute paths and `..`;
- hidden files (`.env`, `.git`, `.ssh`, …) and key files;
- symbolic links anywhere on the path.

It then re-checks the real path; reads use `O_NOFOLLOW`. Nothing writes.

**Permissions** live in `agent_tool_permissions` (one row per enabled tool,
with mode `allow` or `ask`). No row means off, so every agent starts with no
tools. The agent service checks every ID against the registry. A permission
change applies at once: the worker reads permissions per run, and again per
call.

**How a tool call is enforced** (`src/server/tools/invoker.ts`, in the worker):

```
Claude: "call mcp__solas__read_workspace_file { path: 'notes/plan.md' }"
  │  only tools Solas registered for this agent exist in the session
  ▼
Solas MCP server (in-process, SDK createSdkMcpServer) → invoke()
  1. permission   read fresh from agent_tool_permissions → else "denied"
  2. validation   input against the tool's Zod schema   → else "failed"
  3. approval     if required or mode "ask": tool_calls row "awaiting_approval",
                  wait (run clock paused) for approve / reject / expiry (5 min)
  4. execution    tool's time limit, agent's workspace only
  5. contract     output against the tool's schema
  6. record       tool_calls: status, summaries, error
  ▼
text result (or an error the model can read) → back to Claude → next turn
```

**Defense in depth around Claude Code.**
- `tools: []`: no built-in tools at all.
- `allowedTools`: exactly `mcp__solas__<id>` for the permitted tools.
- `permissionMode: "dontAsk"`: anything else is denied.
- A `PreToolUse` hook allows only those names.
- `strictMcpConfig`: no other MCP server.
- At session start, the session's tool list must equal the expected list
  exactly, or the run stops.

The model's only power is to *ask*; every decision is Solas code.

Never offered to agents: shell, code execution, writing files, arbitrary
paths, network access. Tool output is **untrusted** (a file can contain text
that tries to steer the agent); safety comes from least privilege and
approvals, not from trusting the model.

### 5.8 Background tasks and durable execution (built in M4B)

A **task** is work the owner hands to an agent and comes back to later. It
reuses everything conversations already have: the same queue (`runs`), the
same worker, the same `AgentRuntime` and Claude adapter, the same tools,
permissions, and approvals. Only three things are task-specific: the prompt,
where the result goes, and what happens after a failure.

```
Browser            Web (Next.js)                        PostgreSQL              Worker
 │ Create task ──▶ createTask (Server Action, owner guard)
 │                 ├ validate (Zod, shared with the form)
 │                 ├ agent exists, enabled, has a model?
 │                 └ one transaction: task (queued) + run (attempt 1, pending)
 │                   + events "created", "queued" ───────────────▶ tasks, runs, task_events
 │ ◀── { taskId }                                                              claim (SKIP LOCKED, due only)
 │                                                                             + task → running + "claimed"
 │ task page: router.refresh() every 1 s while active ──▶ reads                 ├ agent, tools, prompt (title + instructions)
 │   status, "written so far", approvals, attempts, timeline                    ├ "started", tool steps → task_events
 │                                                                             ├ runtime.run(…) with heartbeat, Stop, timeout
 │ (the tab can close at any time: nothing depends on it)                      └ one transaction: run outcome + task's next
 │                                                                               state + event
```

**Task vs. attempt.** The task row is the owner's request and its final
outcome. Each try is a run: attempt 1, attempt 2 after a retry, and so on.
The page shows both: the task's status, and every attempt with its own
status, timing, model, tokens, and error.

**The state machine** (`src/server/tasks/lifecycle.ts`):

```
 queued ──claimed──▶ running ⇄ awaiting_approval
   │                   ├─▶ completed      result saved; final
   │                   ├─▶ failed         error saved; Retry possible
   │                   ├─▶ interrupted    worker lost and repeating isn't safe; Retry possible
   │                   ├─▶ cancelled      owner's Cancel, confirmed by the worker
   │                   └─▶ queued         automatic retry (when safe)
   └─▶ cancelled       Cancel before a worker took it
 failed / interrupted / cancelled ──Retry──▶ queued (new attempt)
```

Every change goes through `transitionTask()`, which runs
`UPDATE tasks SET status = $to … WHERE id = $id AND status IN (<allowed from>)`.
The database checks the rule in the same statement that applies it, so two
processes racing (Cancel vs. claim, approve vs. expiry) can't both win, and
nothing can move a completed task. State changes are in the same transaction
as the run's change and the event that describes it.

**Claiming, locks, and leases.**
- `claimNextRun()` picks the oldest pending run that is due
  (`not_before` is null or past, by the database clock) with
  `FOR UPDATE SKIP LOCKED`: a row lock that a second worker skips instead of
  waiting for, so one run is never claimed twice. The claim sets
  `status = running`, `worker_id`, `heartbeat_at`, and moves the task to
  running, all in one transaction. If the task can't start (cancelled at that
  instant), the run is cancelled too.
- `heartbeat_at` is the **lease**: the worker refreshes it every second.
  A lease older than 30 s means the worker is gone (crash, kill, power loss).
- Lock order is always run first, then task, in the worker and in Cancel, so
  they can't deadlock.
- Before calling the provider, the worker checks the run's cancel request
  once more, so a Cancel pressed right after the claim never starts Claude.

**After a failure: the retry policy** (`decideAfterFailure`).

| Failure | What happens |
| --- | --- |
| Worker lost (`worker_stopped`: crash, kill, Ctrl+C) or provider outage | Retried automatically **once**, after 15 s (doubling per attempt), but only if no tool with side effects may have run and no approval was pending |
| Lost, but an action with side effects may have run | **Interrupted.** Repeating it could do it twice; the owner checks and decides |
| Lost while an approval was pending | **Interrupted.** That Claude session can't be restored; a new attempt would ask again, so the owner starts it |
| Usage limit, timeout, not signed in, model unavailable, agent disabled, … | **Failed**, never retried automatically. A usage limit would only be hit again, and every try counts against the plan |

Tools declare `sideEffects` in the registry. All M4A tools only read, so a
lost attempt that used them is safe to repeat. A tool that isn't in the
registry counts as having side effects (fail closed).

**Exactly once is not promised.** Database locks guarantee one worker per
attempt and one result per task. They can't guarantee that something outside
the database happened exactly once: if a worker dies after a tool changed
something but before Solas recorded it, only the owner can tell. That is
why such attempts are interrupted, not repeated.

**Cancellation.** A queued task is cancelled at once (its pending run too).
For a running task, Cancel sets `cancel_requested_at` on the task and its
run; the worker's heartbeat sees it within a second, aborts the provider call
(the SDK's abort controller), withdraws any pending approval, and records
"cancelled". Until then the page says "Cancelling…", because that is the
truth. Once stopped, anything the runtime returns is discarded.

**Approvals in tasks** work exactly as in conversations (§5.7, §6.2): the
call waits in `tool_calls`, the task moves to `awaiting_approval` (the
attempt's timeout pauses), and the task page shows the same card with the
exact input. A decision applies to that one call. Rejected, expired, and
withdrawn requests never run.

**Live progress.** The task page and the Tasks list re-render from the
database on a timer while something is active (`LiveRefresh`:
`router.refresh()` every 1 s on a task, 2 s on the list, paused while the tab
is hidden). Why not SSE: one owner, one tab, and polling a server render is
the same pattern conversations use, with nothing new to deploy; the
append-only `task_events` (sequential IDs) make an SSE stream a small change
later. No percentage is shown: the worker can't measure progress, so it
shows real states and real text instead.

**Concurrency.** `SOLAS_WORKER_CONCURRENCY` (1 by default, at most 3) caps
how many runs one worker executes at once, tasks and replies together. The
loop (`runWorkerLoop`) claims only while a slot is free.

**Usage limits.** A `usage_limit` result fails the attempt with Solas's own
message, and the task is never retried automatically, so there is no loop
that keeps spending the plan. The owner retries after the reset.

**Unattended use.** Tasks run while the worker runs on the owner's Mac, with
the owner's own Claude Code sign-in (§5.1). That is still personal, local
use. Running tasks on a server around the clock is a different question,
decided in M10 against the then-current terms (API key by default).

**Files.**

| File | Responsibility |
| --- | --- |
| `src/server/db/schema.ts`, `drizzle/0005_tasks_and_task_events.sql` | `tasks`, `task_events`, new `runs` columns and constraints |
| `src/server/tasks/lifecycle.ts` | State machine, `transitionTask()`, retry policy |
| `src/server/tasks/service.ts` | Web side: create (idempotent), list/search/count, get, cancel, retry |
| `src/server/tasks/execution.ts` | Worker side: claimed, started, tool steps, attempt ended |
| `src/server/tasks/events.ts` | Appends one timeline event |
| `src/server/runs/executor.ts` | Shared run execution; branches to task handlers where tasks differ |
| `src/server/runs/worker-loop.ts`, `src/worker/index.mts` | Job loop with concurrency, recovery timer, shutdown |
| `src/app/(app)/tasks/` | Pages and Server Actions |
| `src/components/tasks/`, `src/components/live-refresh.tsx` | List, form, detail, actions, approvals, live refresh |

**Preparing for hosting.** Nothing here depends on the browser or the laptop
being open: the database holds every state, the worker can restart or move,
and two workers can share one database safely (SKIP LOCKED, leases). On a
VPS, web and worker become two services; what changes is the credential
(M10) and real authentication (M9), not the task design.

## 6. Request flows

### 6.1 Sending a message

Built in M3A, streaming since M3B; see §5.4 to §5.6.

### 6.2 Approval (built in M4A)

```
Worker: a tool needs approval
  → tool_calls row: status "awaiting_approval", approval_expires_at = now() + 5 min
  → the run's timeout pauses; the worker polls the row every 0.5 s
Browser: the conversation polls the run → approval card with the exact input
  → Approve / Reject → decideToolCall (Server Action, owner guard)
  → UPDATE … WHERE status = 'awaiting_approval' AND approval_expires_at > now()
Worker: sees "approved" → flips it to "running" (once) → runs the stored input
        sees "rejected" → the tool never runs; Claude is told not to retry
        expiry passes (database clock) → "expired"; never runs
        Stop pressed → "cancelled"; never runs
```

Limitation: the worker keeps the run (and the Claude session) open while it
waits. If the worker stops during a wait, the request is withdrawn
(`cancelled`) and can't be approved any more. A conversation reply fails as
usual; a task becomes "interrupted", and Retry starts a new attempt that asks
again (§5.8). Resuming a session after a restart is a later refinement.

### 6.3 Scheduled task (M8)

```
Worker scheduler tick → schedules where next_run_at <= now and enabled
  → create a task (as createTask does: task + attempt 1) → advance next_run_at
  → normal task flow (§5.8); result visible under Tasks
```

## 7. Security model

| Concern | Approach |
| --- | --- |
| Claude credentials | Managed only by Claude Code's official sign-in. Never read, stored, or transmitted by Solas |
| Other secrets | `.env.local` / server environment only; `.env*` is git-ignored; never `NEXT_PUBLIC_` |
| Server/client boundary | `import 'server-only'` in `src/server/`; pass only the fields the UI needs |
| Agent execution | Only in the worker (the Agent SDK is not even in the web server bundle); no network listener; no tools in M3A; deny-all policy hook; approvals later |
| Working directories | One workspace per agent under a Solas data directory; never the repo or home directory |
| Shell | No shell tool for agents; no endpoint anywhere that runs commands |
| Network exposure (dev) | `npm run dev` / `npm start` bind to `127.0.0.1` (since M2A); PostgreSQL is published on `127.0.0.1` only |
| Owner guard (until M9) | `requireOwner()`: fail-closed; local owner mode + loopback `Host` (§4a) |
| Database input | Zod validation in the service; strict objects; unique index and check constraints in the database |
| Authentication | Single owner (M9) before any network exposure; checks in the data layer, not only in Proxy |
| Mutations | Server Actions (origin-checked) and Route Handlers (validate `Origin` and body) |
| Abuse and cost | Budgets per run, one concurrent run by default (at most 3), no automatic retry after a usage limit, bounded retries otherwise, rate limits (M9) |
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
│  │  ├─ tasks/ …             list, new, [taskId] (M4B)
│  │  ├─ automations/ …       schedules (M8)
│  │  ├─ loading.tsx          skeleton shown while a page loads
│  │  └─ settings/
│  ├─ (auth)/login/           (M9)
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
│  ├─ conversations/          service, queries, errors                      (M3A)
│  ├─ runs/                   executor, prompt, config, worker-loop         (M3A, M4B)
│  ├─ runtime/                AgentRuntime types, claude-agent-sdk adapter  (M3A)
│  ├─ logger.ts               JSON-line logs, scalar fields only            (M3A)
│  ├─ tools/                  registry, builtin/ tools, workspace, invoker  (M4A)
│  ├─ tasks/                  lifecycle, service, execution, events         (M4B)
├─ test/                      Vitest global setup (test database)           (M2A)
├─ worker/index.mts          worker entry point and job loop               (M3A)
└─ proxy.ts                   (M9)

drizzle/                      generated SQL migrations (committed)          (M2A)
scripts/agents.mts            dev-only CLI for the agent backend            (M2A)
e2e/, playwright.config.ts    browser tests against their own database       (M3B)
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
| Runtime | A fake `AgentRuntime` (executor tests) and a fake SDK `query` (adapter tests) | Since M3A: instructions passed through, error mapping, refusals, timeouts, Stop, recovery, no Claude call. Since M4B: tasks end to end (claim races, retries, leases, crash and shutdown recovery, side-effect safety, approvals, cancellation, concurrency) |
| End-to-end | Playwright (since M3B): `npm run test:e2e` builds the app and runs it on port 3100 against `solas_e2e_test`, which the tests fill directly | Conversations: navigation, reload, streaming, Markdown, rename, delete, duplicates, retry, keyboard, themes (contrast measured), mobile. No worker, so no Claude |
| Manual | Per-milestone checklist | Both themes, keyboard only, 375px, real agent run |

`src/test/global-setup.ts` creates `solas_test` if needed and applies
migrations. It refuses to run against a database whose name doesn't end in
`_test`, because the tests delete rows.

Automated tests never call the real Claude service. That keeps them free,
fast, deterministic, and off the subscription limits.
