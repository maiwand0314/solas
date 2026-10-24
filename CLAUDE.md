# CLAUDE.md

Guidance for Claude Code when working in this repository.

@AGENTS.md

## What this project is

Solas is a private, single-owner platform for creating and running a team of
AI agents. It is built from scratch as a real application and as the owner's
learning and portfolio project.

- Do not copy code, branding, or UI from MausBot / OpenMausBot or any other
  product. Inspiration is conceptual only.
- The owner is learning. Explaining is part of the work.

Read the relevant document before starting a task:

| File | Purpose |
| --- | --- |
| `PROJECT_PLAN.md` | Vision, MVP, milestones, open decisions, risks |
| `ARCHITECTURE.md` | Components, data model, runtime decision, flows, security model |
| `DESIGN_SYSTEM.md` | Tokens, typography, layout, components, accessibility |
| `LEARNING_LOG.md` | What was learned in each milestone |

## Working agreement (every milestone)

1. Explain the objective.
2. Explain the architecture of the change.
3. Implement only the agreed scope.
4. Keep the code clean and maintainable.
5. Run the relevant checks and tests, and report results honestly.
6. Explain which files changed.
7. Explain what was learned, and add it to `LEARNING_LOG.md`.
8. Suggest the next milestone.
9. Stop. Do not start the next major feature without the owner's go-ahead.

Also:

- Commit only when the owner asks. Never push without being asked.
- No code "for later". Build what the current milestone needs.
- Keep explanations and changes small enough to understand.

## Stack (as installed)

- Next.js 16.4 (App Router, `src/` directory, `@/*` → `src/*`)
- React 19.3, TypeScript 5.9 (`strict`)
- Tailwind CSS 4.3 through the `@tailwindcss/turbopack` loader in
  `next.config.ts` (no PostCSS config)
- `cacheComponents: true` and `partialPrefetching: true` in `next.config.ts`
- ESLint 9 flat config with `eslint-config-next`
- Node.js 24, npm

This Next.js version differs from older material. Read the matching guide in
`node_modules/next/dist/docs/` before writing Next.js code. Known differences:
Middleware is now **Proxy** (`src/proxy.ts`), `LayoutProps` / `PageProps` are
global types, and Cache Components require `<Suspense>` or `'use cache'` for
dynamic data.

## Commands

```bash
npm run db:up        # start local PostgreSQL (Docker); db:down stops, db:reset wipes data
npm run db:migrate   # apply migrations; db:generate creates one after editing src/server/db/schema.ts
npm run dev          # dev server on 127.0.0.1:3000
npm run worker       # the agent worker: runs agents (Claude). Start it next to dev/start
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit (run after a build or dev start; stale .next/types can mislead)
npm test             # Vitest: unit + integration tests (needs db:up)
npm run test:e2e     # Playwright browser tests: builds, then runs on port 3100 with its own database
npm run build        # production build
npm run agents -- list   # dev-only CLI for the agent backend (see scripts/agents.mts)
```

First-time setup: copy `.env.example` to `.env.local`, choose a password, then
`npm run db:up && npm run db:migrate`.

## Architecture rules

- Web process (`src/app/`) never runs agents. The worker (`src/worker/`) does.
  They communicate only through PostgreSQL.
- Domain and data-access code lives in `src/server/` with `import 'server-only'`.
- The worker depends on the `AgentRuntime` interface, never directly on an SDK.
  SDK types stay inside their adapter.
- Server Components by default; `'use client'` only for interactive leaves.
- Use design tokens; never hard-coded colors. See `DESIGN_SYSTEM.md`.
- Match the surrounding code's naming and comment density; comment the *why*.

## Dependencies

Do not add a dependency without explaining why, naming the alternative without
it, and getting the owner's approval.

## Security rules (non-negotiable)

- **Claude credentials:** Solas reaches Claude only through official Anthropic
  tooling (Claude Agent SDK / Claude Code CLI) and official sign-in. Never read,
  copy, print, or store `~/.claude/.credentials.json`, Keychain entries, OAuth
  tokens, or session tokens. Never set `CLAUDE_CODE_OAUTH_TOKEN` in code. Never
  modify the Claude Code binary or work around usage limits.
- **Agent tools:** start from nothing allowed. Never use `bypassPermissions`.
  No shell tool, no arbitrary filesystem paths, no arbitrary network access.
  Agents work only inside their own workspace directory.
- **Approvals:** sensitive operations require owner approval.
- **No exposed execution:** the worker has no network listener. No endpoint
  anywhere runs shell commands.
- **Secrets:** only in `.env.local` / server environment (`.env*` is
  git-ignored). Never `NEXT_PUBLIC_`. Never committed, logged, or echoed.
- **Deployment:** nothing is deployed or exposed publicly without auth and a
  security review. Never provision paid services without explicit approval.
