# Agent guide

<!-- stack:start:overview -->

Nx monorepo: **TanStack Start** web app → **GraphQL** API (Yoga + Pothos) → **Drizzle** → Postgres 18 (Docker).
Business logic lives in `packages/core`; apps are thin wrappers around it.
<!-- stack:end -->

<!-- kit:start:done -->

## Done means

1. `pnpm check` passes (lint, formatting, module boundaries, typecheck, tests, builds, generated-file drift, agent config).
2. The stack's extra checks below pass.
3. If you changed runtime behavior: you ran it and verified the behavior yourself.

Never claim "done" without running these. If a check fails, fix the cause; never weaken a test or a rule to pass.
<!-- kit:end -->

<!-- stack:start:done -->

Stack checks: `pnpm check` also runs the database tests, which need **Docker** (each test file gets its own
Postgres database). The web app (M4+) adds `pnpm nx e2e web-e2e` for route and UI changes.

<!-- stack:end -->

<!-- kit:start:commands -->

## Commands

| Task                                             | Command                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| All checks (definition of done)                  | `pnpm check` (`--all` for every project)                         |
| Regenerate generated files                       | `pnpm regen`                                                     |
| Format everything (hooks format what you edit)   | `pnpm format`                                                    |
| One target                                       | `pnpm nx run <project>:<target>` (e.g. `pnpm nx run tools:test`) |
| Only what changed                                | `pnpm nx affected -t lint eslint typecheck test build`           |
| What exists / depends on what                    | `pnpm nx show projects`, `pnpm nx show project <name> --json`    |
| Sync agent skills after editing `.agents/skills` | `pnpm agents:sync`                                               |

- **pnpm only**, never npm/yarn/npx. Add dependencies with `pnpm add <pkg> --filter <project>`; versions come from the catalog in `pnpm-workspace.yaml`.
- Always run tools **through Nx** (`pnpm nx run …`), never `vitest`, `tsc`, `eslint` or `vite` directly — Nx provides the project graph, caching and the correct working directory.
- Never run `nx configure-ai-agents` (it rewrites agent config; humans run it deliberately).

<!-- kit:end -->

<!-- stack:start:commands -->

- **Where is the app running?** `pnpm ports` prints this checkout's URLs, ports and database URLs.

**Database** (Postgres 18 in Docker, one per checkout/worktree; Docker must be running):

| Task                                         | Command                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Start it (fast no-op when running)           | `pnpm db:up`                                                                              |
| Apply migrations / reseed deterministic data | `pnpm db:migrate` / `pnpm db:seed`                                                        |
| Change the schema                            | edit `packages/db/src/schema/*`, then `pnpm nx run db:db-generate --args="--name=<what>"` |
| Wipe and start fresh                         | `pnpm db:reset`                                                                           |
| Browse data                                  | `pnpm db:studio` · `pnpm nx run db:db-psql`                                               |

**API** (`apps/api`, GraphQL at `/graphql`, health at `/health`):

| Task                                                   | Command                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Run it (migrates first; this checkout's port; reloads) | `pnpm nx run api:dev` (GraphiQL at the printed URL)                                        |
| Change the schema                                      | edit `apps/api/src/graphql/*`, then `pnpm nx run api:print-schema` (or `pnpm regen`)       |
| Production bundle (what the image runs)                | `pnpm nx run api:build`, then in `apps/api`: `node dist/migrate.mjs`, `node dist/main.mjs` |

<!-- stack:end -->

<!-- kit:start:navigation -->

## How to navigate (use the right graph, grep last)

- **Structure, ownership, impact** → Nx project graph: `pnpm nx show projects --affected`, `pnpm nx show project <p> --json`.
- **Definitions, callers, renames** → the TypeScript LSP (go to definition, find references, call hierarchy).
- **Generated maps** (read-only) → the stack's list below.
- **grep** only for strings, config values and comments.

<!-- kit:end -->

<!-- stack:start:navigation -->

- **API shape** → `packages/graphql/schema.graphql` (printed from `apps/api/src/graphql`; never edit it by hand).
- **Pages and params** → `apps/web/src/routeTree.gen.ts` (arrives with the web app).

<!-- stack:end -->

<!-- stack:start:map -->

## Repo map

| Path                  | What                                                                                                 | Tags                            |
| --------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------- |
| `apps/api`            | GraphQL API: Yoga + Pothos on Node; env schema, security defaults, tsdown bundle                     | `scope:api`, `type:app`         |
| `packages/core`       | business logic: writes and domain errors (`createNote`, `addComment`); takes a `Db`, never a request | `scope:server`, `type:feature`  |
| `packages/db`         | Drizzle schema, relations, migrations, deterministic seed, per-test-file databases (`testDb()`)      | `scope:server`, `type:data`     |
| `packages/graphql`    | `schema.graphql`: the API contract clients generate their types from (generated)                     | `scope:shared`, `type:util`     |
| `packages/validators` | Zod schemas + limits shared by api and web                                                           | `scope:shared`, `type:util`     |
| `tools`               | dev ports, Claude Code hooks, `pnpm check`, agent-config sync                                        | `scope:tooling`, `type:tooling` |
| `docker-compose.yml`  | the local Postgres (dev, e2e, tests only)                                                            |                                 |

`tools` is plain `.mjs` with no `typecheck` target: its gates are lint, boundaries and tests. Projects tagged
`needs-db` need Docker for their tests (`pnpm nx affected -t test --exclude=tag:needs-db` skips them).

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
- **Writes go through `packages/core`** (validated again there, domain errors like `NotFoundError`); reads use
  Drizzle's relational queries (in the API: the Pothos Drizzle plugin), which plan nested data as one statement.
- **Migrations:** generate them from the schema and commit them. Once git tracks a migration (staged or
  committed) the guard hook blocks edits to it; only a new, untracked one may still be edited.
- **The schema has no side effects at import:** nothing under `apps/api/src/graphql` reads the environment or opens a
  connection (the database comes from the request context), so `print-schema` runs with an empty environment; a test
  enforces it. The environment is validated once, at startup (`apps/api/src/env.ts`).
- **The API is private and locked down by default:** CSRF prevention, graphql-armor limits, and introspection,
  GraphiQL and field suggestions in development only. In production it listens for the web server alone and requires
  `INTERNAL_API_SECRET` on every request but `/health`; in development it listens on 127.0.0.1 and ignores it (even
  when `.env` sets it). Tests pin each default: change one only on purpose.
- **Tests that touch the database** use `testDb()` from `@acme/db/testing` and assume nothing about other tests'
  rows (tests in one file share its database; files never share).

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
