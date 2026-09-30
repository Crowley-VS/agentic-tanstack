# Agent guide

<!-- stack:start:overview -->

Nx monorepo: **TanStack Start** web app → **GraphQL** API (Yoga + Pothos) → **Drizzle** → Postgres 18 (Docker).
Business logic lives in `packages/core`; apps are thin wrappers around it.
<!-- stack:end -->

<!-- kit:start:done -->

## Done means

1. `pnpm check` passes (lint, formatting, module boundaries, typecheck, tests, generated-file drift, agent config).
2. The stack's extra checks below pass.
3. If you changed runtime behavior: you ran it and verified the behavior yourself.

Never claim "done" without running these. If a check fails, fix the cause; never weaken a test or a rule to pass.
<!-- kit:end -->

<!-- stack:start:done -->

Stack checks: none yet. The web app (M2+) adds `pnpm nx e2e web-e2e` for route and UI changes.
<!-- stack:end -->

<!-- kit:start:commands -->

## Commands

| Task                                             | Command                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| All checks (definition of done)                  | `pnpm check` (`--all` for every project)                         |
| Regenerate generated files                       | `pnpm regen`                                                     |
| Format everything (hooks format what you edit)   | `pnpm format`                                                    |
| One target                                       | `pnpm nx run <project>:<target>` (e.g. `pnpm nx run tools:test`) |
| Only what changed                                | `pnpm nx affected -t lint eslint typecheck test`                 |
| What exists / depends on what                    | `pnpm nx show projects`, `pnpm nx show project <name> --json`    |
| Sync agent skills after editing `.agents/skills` | `pnpm agents:sync`                                               |

- **pnpm only**, never npm/yarn/npx. Add dependencies with `pnpm add <pkg> --filter <project>`; versions come from the catalog in `pnpm-workspace.yaml`.
- Always run tools **through Nx** (`pnpm nx run …`), never `vitest`, `tsc`, `eslint` or `vite` directly — Nx provides the project graph, caching and the correct working directory.
- Never run `nx configure-ai-agents` (it rewrites agent config; humans run it deliberately).

<!-- kit:end -->

<!-- stack:start:commands -->

- **Where is the app running?** `pnpm ports` prints this checkout's URLs, ports and database URLs.

<!-- stack:end -->

<!-- kit:start:navigation -->

## How to navigate (use the right graph, grep last)

- **Structure, ownership, impact** → Nx project graph: `pnpm nx show projects --affected`, `pnpm nx show project <p> --json`.
- **Definitions, callers, renames** → the TypeScript LSP (go to definition, find references, call hierarchy).
- **Generated maps** (read-only) → the stack's list below.
- **grep** only for strings, config values and comments.

<!-- kit:end -->

<!-- stack:start:navigation -->

- **API shape** → `packages/graphql/schema.graphql` (arrives with the API).
- **Pages and params** → `apps/web/src/routeTree.gen.ts` (arrives with the web app).

<!-- stack:end -->

<!-- stack:start:map -->

## Repo map

| Path                  | What                                                          | Tags                            |
| --------------------- | ------------------------------------------------------------- | ------------------------------- |
| `packages/validators` | Zod schemas + limits shared by api and web                    | `scope:shared`, `type:util`     |
| `tools`               | dev ports, Claude Code hooks, `pnpm check`, agent-config sync | `scope:tooling`, `type:tooling` |

`tools` is plain `.mjs` with no `typecheck` target: its gates are lint, boundaries and tests.

<!-- stack:end -->

<!-- kit:start:invariants -->

## Invariants (enforced by lint, hooks or tests)

- **Generated files are read-only.** They are listed in `.agents/generated.json`; edit the source and run the regen command it names (or `pnpm regen`).
- **Module boundaries** (`eslint` target): a project's tags decide what it may import; the stack's rules are below.
- **Skills**: edit `.agents/skills/<name>/SKILL.md`, then `pnpm agents:sync` (`.claude/skills` holds generated copies).
- **Secrets**: never read or print `.env*` files; add new variables to `.env.example` and the app's env schema.

<!-- kit:end -->

<!-- stack:start:invariants -->

- Boundary rules (full list in `eslint.config.mjs`): `scope:shared` → shared only; `scope:tooling` → tooling only; `scope:web` → web/shared; `scope:api` → api/server/shared; `scope:server` → server/shared; `type:util` → util only, and imports no frameworks, Drizzle or `pg`.

<!-- stack:end -->

<!-- kit:start:pull-requests -->

## Pull requests (one per phase)

1. Finish the phase; `pnpm check` must pass.
2. Commit on a branch (never directly on `main`) and open a PR with a summary and a test plan.
3. Run the **review loop** (skill `review-loop`): review → post findings → fix → check the fixes until no
   blocker/major issue is open. When a PR is opened from Claude Code (drafts: on `gh pr ready`), the hook
   `tools/agent-hooks/pr-opened.mjs` has Claude offer it and start it once the user agrees; `REVIEW_LOOP_AUTO=1`
   (the user's opt-in) starts it without asking, `REVIEW_LOOP_AUTO=0` turns the hook off.
4. A human merges.

<!-- kit:end -->

<!-- kit:start:workflow -->

## Working style

- Plans and scratch notes go in `.agents/ignore/plans/YYYY-MM-DD-topic.md` (gitignored).
- Anything you verified by hand should become a test.

<!-- kit:end -->

<!-- stack:start:workflow -->

- Parallel work: each git worktree gets its own ports and database automatically (`pnpm ports`).

<!-- stack:end -->
