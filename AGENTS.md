# Agent guide

<!-- stack:start:overview -->

Nx monorepo: **TanStack Start** web app → **GraphQL** API (Yoga + Pothos) → **Drizzle** → Postgres 18 (Docker).
Business logic lives in `packages/core`; apps are thin wrappers around it.
Before you work on an area, read its doc (how to run, build and test it; its rules): `docs/api.md`, `docs/web.md`, `docs/e2e.md`, `docs/database.md`, `docs/deployment.md`.

<!-- stack:end -->

<!-- kit:start:done -->

## Done means

1. `pnpm check` passes (lint, formatting, module boundaries, typecheck, tests, builds, generated-file drift, agent config) on the affected projects; `--all` checks every project.
2. The stack's extra checks below pass.
3. If you changed runtime behavior, you ran it and saw it work.

Never claim "done" without these. If a check fails, fix the cause; never weaken a test or a rule.

<!-- kit:end -->

<!-- stack:start:done -->

Stack checks: Docker must run (`pnpm check` runs the database tests). Route, UI or API changes also need `pnpm nx e2e web-e2e` (production builds, own ports and database: `docs/e2e.md`). Dockerfile, `.dockerignore` or `docker-compose.stack.yml` changes need `pnpm nx run web-e2e:e2e-stack`: the specs against the images (`docs/deployment.md`). Browser tests (`*.browser.test.{ts,tsx}`) need Chromium, once per machine and after each Playwright bump: `pnpm exec playwright install chromium`.

<!-- stack:end -->

<!-- kit:start:commands -->

## Commands

- `pnpm regen`: regenerate every generated file.
- `pnpm format`: format everything (hooks format the files you edit).
- `pnpm nx run <project>:<target>`: one target (e.g. `pnpm nx run tools:test`).
- `pnpm nx affected -t lint eslint typecheck test test-browser build`: only what changed.
- **pnpm only**, never npm, yarn or npx. Add a dependency with `pnpm add <pkg> --filter <project>`; versions come from the catalog in `pnpm-workspace.yaml`.
- Run tools **through Nx** (`pnpm nx run …`), never `vitest`, `tsc`, `eslint` or `vite` directly: Nx gives them the project graph, the cache and the right working directory.
- Never run `nx configure-ai-agents`: it rewrites agent config; humans run it deliberately.

<!-- kit:end -->

<!-- stack:start:commands -->

- `pnpm ports`: this checkout's URLs, ports and database URLs (each git worktree gets its own).
- `pnpm dev` in the background: web + API, reloading. Curl the web's `/api/health` and the API's `/health`; stop it when done. Writes per IP are rate-limited, in dev too (`docs/web.md`).
- Database: `pnpm db:up` (a no-op when it is up), `pnpm db:migrate`, `pnpm db:seed` (deterministic data), `pnpm db:reset` (wipes the data). Schema changes: Migrations, below.
- `pnpm teardown` stops this checkout's Postgres and Nx daemon (data kept) and removes its image stack: run it before you leave or delete a worktree, once no server runs there (stop yours; skip it while a `pnpm dev` you did not start runs). `pnpm prune:orphans` removes what deleted worktrees left behind (`pnpm db:up` does the Docker part too, when it starts the server). Details: `docs/local-resources.md`.

<!-- stack:end -->

<!-- kit:start:navigation -->

## How to navigate (use the right graph, grep last)

- **Structure, ownership, impact** → the Nx project graph: `pnpm nx show projects` (`--affected`: what a change touches), `pnpm nx show project <name> --json` (its targets and tags).
- **Definitions, callers, renames** → the TypeScript LSP (go to definition, find references, call hierarchy).
- **Generated maps** (read-only) → the stack's list below.
- **grep** only for strings, config values and comments.

<!-- kit:end -->

<!-- stack:start:navigation -->

- **API shape** → `packages/graphql/schema.graphql`, printed from `apps/api/src/graphql` by `pnpm nx run api:print-schema` (run it after every schema edit).
- **Pages and params** → `apps/web/src/routeTree.gen.ts`, generated from `apps/web/src/routes` by `pnpm nx run web:generate-routes` (after adding or renaming a route file).
- **Operation types** → `apps/web/src/gql`, generated from the `graphql()` calls in `apps/web/src` by `pnpm nx run web:codegen` (`pnpm dev` runs it on save).

<!-- stack:end -->

<!-- stack:start:map -->

## Repo map

- `apps/api` (`scope:api`, `type:app`, `needs-db`): the GraphQL API: Notes queries, mutations, security defaults.
- `apps/web` (`scope:web`, `type:app`): TanStack Start (SSR on Nitro): pages, `/api/health`, the `/api/graphql` BFF.
- `apps/web-e2e` (`scope:web`, `type:e2e`): Playwright specs on the production builds, e2e ports and a freshly seeded database.
- `packages/core` (`scope:server`, `type:feature`, `needs-db`): business logic: writes and domain errors; takes a `Db`, never a request.
- `packages/db` (`scope:server`, `type:data`, `needs-db`): Drizzle schema, migrations, seed, per-test-file databases (`testDb()`).
- `packages/graphql` (`scope:shared`, `type:util`): `schema.graphql`, the generated API contract clients get their types from.
- `packages/logger` (`scope:shared`, `type:util`): one log line per event for the servers (JSON in production: `docs/production.md`); server code only.
- `packages/ui` (`scope:web`, `type:ui`): React components (shadcn/ui, radix-nova) and the Tailwind 4 theme. Add one with `pnpm --filter @acme/ui exec shadcn add <name> --overwrite` (without `--overwrite` it writes nothing when no terminal is attached), then `pnpm format` and `git diff packages/ui` (`docs/web.md`).
- `packages/validators` (`scope:shared`, `type:util`): Zod schemas and limits shared by api and web.
- `tools` (`scope:tooling`, `type:tooling`): dev ports, Claude Code hooks, `pnpm check`, agent-config sync; plain `.mjs`, gated by lint, boundaries and tests (no `typecheck`).
- `.railway` (`railway-iac`, `scope:tooling`, `type:tooling`): Railway infrastructure as code (experimental, `docs/deployment-railway.md`); every `railway` command asks first; agents never log in.
- `docker-compose.yml`: the local Postgres (dev, e2e and tests only); `docker-compose.stack.yml`: the production images (`apps/*/Dockerfile`) run together locally.

Without Docker, `pnpm nx affected -t test --exclude=tag:needs-db` skips the `needs-db` projects.

<!-- stack:end -->

<!-- kit:start:invariants -->

## Invariants (enforced by lint, hooks or tests)

- **Generated files are read-only.** `.agents/generated.json` lists them and the command that regenerates each: edit the source, then run it (or `pnpm regen`).
- **Module boundaries** (`eslint` target): a project's tags decide what it may import (the stack's rules are below).
- **Skills**: edit `.agents/skills/<name>/SKILL.md`, then `pnpm agents:sync` (`.claude/skills` holds generated copies).
- **Secrets**: never read or print `.env*` files; add a new variable to `.env.example` and the app's env schema.

<!-- kit:end -->

<!-- stack:start:invariants -->

- Boundaries (full list in `eslint.config.mjs`): `scope:shared` → shared; `scope:tooling` → tooling; `scope:web` → web, shared; `scope:api` → api, server, shared; `scope:server` → server, shared; `type:util` → util only, and no frameworks, Drizzle or `pg`.
- **Writes go through `packages/core`**, which validates again and throws domain errors (`NotFoundError`). Reads use Drizzle's relational queries (in the API: the Pothos Drizzle plugin), which load nested data in one statement.
- **Migrations**: edit `packages/db/src/schema/*`, run `pnpm nx run db:db-generate --args="--name=<what>"` and commit the result. The guard hook blocks edits to a migration git tracks (staged or committed); only a new, untracked one may change.
- **API** (`docs/api.md`): the schema has no side effects at import; the API is private and locked down by default (tests pin each default); expected failures are data (union members, selected by `__typename`); its Vitest config aliases `graphql` to one copy.
- **Server-only code lives in `*.server.ts`** (env, API client, BFF): a client import of one fails the build, and so does server code in the client bundle. The browser reaches the API only through the same-origin `/api/graphql`.
- **Web data** (`docs/web.md`): only through `execute()` with a `graphql()` document. Loaders `await ensure…()` and return nothing; components `useSuspense…` the same query options. Forms copy `apps/web/src/components/note-form.tsx`.
- **Tests that touch the database** use `testDb()` from `@acme/db/testing`. Each test file gets its own database, shared by its tests: assume nothing about other tests' rows.

<!-- stack:end -->

<!-- kit:start:pull-requests -->

## Pull requests (one per phase)

1. Finish the phase; `pnpm check` passes.
2. Commit on a branch (never on `main`); open a PR with a summary and a test plan.
3. Run the **review loop** (skill `review-loop`): review → post findings → fix → check the fixes, until no blocker or major issue is open. In Claude Code, the hook `tools/agent-hooks/pr-opened.mjs` offers it when a PR opens (a draft: on `gh pr ready`) and starts it once the user agrees; `REVIEW_LOOP_AUTO=1` (the user's opt-in) starts it without asking, `REVIEW_LOOP_AUTO=0` turns the hook off.
4. A human merges.

<!-- kit:end -->

<!-- kit:start:workflow -->

## Working style

- Plans and scratch notes go in `.agents/ignore/plans/YYYY-MM-DD-topic.md` (gitignored).
- Turn anything you verified by hand into a test.

<!-- kit:end -->

<!-- stack:start:workflow -->

Task skills (`.agents/skills`), each with its steps, commands and checks:

- A field or feature end to end (schema → core → API → UI → e2e): `add-feature`.
- A schema change and its migration (deploy-safe: expand, then contract): `db-migration`.
- The GraphQL API shape (Pothos, print-schema, codegen, deprecation): `graphql-change`.
- A Playwright spec, or a failing e2e run: `e2e-test`.
- A shadcn/ui component in `packages/ui`: `add-ui-component`.
- Run the app and see a change work (dev, BFF, production build, images): `run-web`.
- Before saying "done" (the checks each change needs, the evidence): `verify`.
- Upgrading Nx and its plugins: `nx-upgrade`.

<!-- stack:end -->
