# CLAUDE.md

Permanent instructions for Claude Code in this repository. Details live in the
documents below; this file holds the rules that apply to every task.

@AGENTS.md

## Solas

Solas is a private, single-owner platform for creating and running a team of
AI agents: each agent has its own identity, instructions, model, tools,
permissions, conversations, and tasks, and agents can delegate work to each
other. It runs locally today and later on a private VPS. It is built from
scratch as a real application and as the owner's learning and portfolio
project.

- Never copy code, branding, or UI from MausBot / OpenMausBot or any other
  product. Quality references (Linear, Raycast, Vercel, Notion) set the bar,
  not the look.
- The owner is learning: explaining is part of the work. Reply to the owner in
  Norwegian; write code, comments, commits, and docs in English.

| Document | Holds |
| --- | --- |
| `PROJECT_PLAN.md` | Vision, roadmap and milestone status, open decisions, risks |
| `ARCHITECTURE.md` | Components, data model, flows, security model, technical decisions |
| `DESIGN_SYSTEM.md` | Tokens, typography, layout, components, accessibility checklist |
| `LEARNING_LOG.md` | What each milestone built, taught, and how it was verified |

Read the relevant ones before a task, and check the actual code: never assume
a milestone is complete because a document says so.

## Architecture (summary; details in ARCHITECTURE.md)

- **Two processes, one database.** The web app (`src/app/`) never runs agents.
  The worker (`src/worker/`, no network listener) does. They communicate only
  through PostgreSQL.
- **One queue, one engine.** `runs` is the job queue for conversation replies,
  task attempts, and delegated tasks. Extend it; never add a second queue,
  orchestration engine, or framework.
- **Replaceable model layer.** The worker depends on the `AgentRuntime`
  interface; SDK types stay inside their adapter.
- **Domain code** lives in `src/server/` with `import 'server-only'`. Pages read
  through owner-guarded query helpers; mutations go through Server Actions that
  call `requireOwner()`.
- **Durable state over open processes.** Status lives in rows and changes
  through conditional updates (see `src/server/tasks/lifecycle.ts`); nothing
  important waits in memory.
- Server Components by default; `'use client'` only for interactive leaves.
- Match the surrounding code's naming and comment density; comment the *why*.

## Stack (as installed)

- Next.js 16.4 (App Router, `src/`, `@/*` → `src/*`), React 19.3, TypeScript 5.9 (`strict`)
- Tailwind CSS 4.3 via `@tailwindcss/turbopack` in `next.config.ts` (no PostCSS config)
- `cacheComponents: true` and `partialPrefetching: true`
- PostgreSQL 18 (Docker Compose), Drizzle ORM with committed SQL migrations, Zod 4
- Claude Agent SDK (pinned), run only by the worker
- Vitest, Playwright, ESLint 9 flat config; Node.js 24, npm

This Next.js differs from older material: read the matching guide in
`node_modules/next/dist/docs/` before writing Next.js code. Middleware is
**Proxy** (`src/proxy.ts`), `LayoutProps` / `PageProps` are global types, and
dynamic data needs `<Suspense>` or `'use cache'`.

## Commands

```bash
npm run db:up        # local PostgreSQL (Docker); db:down stops, db:reset wipes data (never without asking)
npm run db:migrate   # apply migrations; db:generate creates one after editing src/server/db/schema.ts
npm run dev          # dev server on 127.0.0.1:3000
npm run worker       # the agent worker; start it next to dev/start
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit (after a build or dev start; stale .next/types can mislead)
npm test             # Vitest: unit + integration (needs db:up)
npm run test:e2e     # Playwright: builds, runs on port 3100 with its own database
npm run build        # production build
npm run agents -- list   # dev-only CLI for the agent backend
```

First-time setup: copy `.env.example` to `.env.local`, choose a password, then
`npm run db:up && npm run db:migrate`.

## Security and agent permissions (non-negotiable)

- **Claude credentials:** reach Claude only through official Anthropic tooling
  (Agent SDK / Claude Code) and official sign-in. Never read, copy, print, or
  store `~/.claude/.credentials.json`, Keychain entries, or OAuth/session
  tokens; never set `CLAUDE_CODE_OAUTH_TOKEN` in code; never modify the Claude
  Code binary, work around usage limits, or switch silently to paid API usage.
- **Least privilege:** agents start with nothing. Tools are registered in
  backend code only, off by default, enabled per agent, and checked by the
  backend on every call. The model can only ask; its text never changes a rule.
- **Never:** `bypassPermissions`, a shell tool, arbitrary filesystem paths, or
  arbitrary network access. File tools stay inside
  `~/Solas/workspaces/<agent-id>` (`SOLAS_WORKSPACES_DIR`), never the repo or
  home folder.
- **Approvals:** sensitive actions wait for the owner; rejected or expired
  requests never run. Never auto-approve.
- **Delegation:** off by default, explicit targets only, bounded depth and
  budget; a delegated agent uses only its own tools and gets only the request
  it was sent.
- **No repeated side effects:** never re-run non-idempotent actions
  automatically; retries are bounded and only when provably safe.
- **No exposed execution:** no endpoint anywhere runs shell commands; the
  worker has no listener; dev servers bind to `127.0.0.1`.
- **Secrets:** only in `.env.local` / server environment (`.env*` is
  git-ignored). Never `NEXT_PUBLIC_`, never committed, logged, or echoed.
- **Data:** never delete the owner's records or reset Docker volumes without
  asking. Migrations are additive unless agreed otherwise.
- **Deployment:** nothing is deployed or exposed without auth and a security
  review; never provision paid services without explicit approval.

## Design (details in DESIGN_SYSTEM.md)

Calm, precise, premium: restrained surfaces, hairline borders, one accent,
hierarchy through type and spacing. Light, dark, and system themes are all
first-class. Use design tokens only, never hard-coded colors. No neon or
multi-stop gradients, heavy glassmorphism, oversized cards, decorative
motion, generic AI-dashboard styling, or fake data and activity. Every UI
change works at 375, 768, and 1280 px without sideways scrolling, keyboard
only with visible focus, and with WCAG AA contrast in both themes. Don't
redesign unrelated pages, and don't design the final logo.

## Quality and testing

- Run `lint`, `typecheck`, `test`, `build`, and the relevant `test:e2e` for
  every change; report the real results, including failures and what wasn't
  tested. Never claim a test passed that didn't run.
- Use real PostgreSQL for integration tests where database behavior matters;
  fake the runtime so automated tests never call Claude.
- A real Claude run comes only after the automated tests pass, is small and
  controlled (prefer a cheap model for test agents), and is reported with
  evidence from the database.
- Treat flaky tests as timing bugs: find the cause, don't retry until green.
- Add a dependency only after explaining why, naming the alternative without
  it, and getting the owner's approval.

## Working agreement (every milestone)

1. Audit the relevant code and documents first; reuse what works and don't
   recreate working infrastructure. Fix a missing critical prerequisite with
   the smallest change.
2. Explain the objective and the architecture of the change.
3. Implement only the agreed scope, in small understandable steps. No code
   "for later".
4. Run the checks above and report honestly.
5. Explain which files changed and why.
6. Explain what was learned and add a milestone entry to `LEARNING_LOG.md`
   (concepts, lessons, honest limitations, files, verification, an exercise).
   Update `PROJECT_PLAN.md` and `ARCHITECTURE.md` to match what was built.
7. Suggest the next milestone, then **stop**. Never start the next milestone
   or another major feature without the owner's go-ahead.

## Git

- After each finished piece of functionality, once its checks pass, make a
  dedicated, focused commit (e.g. database, engine, UI, tests, docs as
  separate commits) and push to `main` on `origin`, without asking first. This
  holds even when a pasted spec says otherwise.
- Never commit secrets, never force-push, never rewrite pushed history; ask
  before anything destructive.
