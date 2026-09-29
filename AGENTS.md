<!-- intent-skills:start -->
<!-- intent-skills:end -->

# Agent guide

<!-- stack:start:overview -->

Nx monorepo: **TanStack Start** web app → **GraphQL** API (Yoga + Pothos) → **Drizzle** → Postgres 18 (Docker).
Business logic lives in `packages/core`; apps are thin wrappers around it.
<!-- stack:end -->

<!-- kit:start:done -->

## Done means

1. `pnpm check` passes (lint, module boundaries, typecheck, tests, generated-file drift, agent config).
2. If you changed routes or UI: `pnpm nx e2e web-e2e` passes.
3. If you changed runtime behavior: you ran the app and verified it (skill: `verify`).

Never claim "done" without running these. If a check fails, fix the cause; never weaken a test or a rule to pass.
<!-- kit:end -->

<!-- kit:start:commands -->

## Commands

| Task                                             | Command                                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| All checks (definition of done)                  | `pnpm check` (`--all` for every project)                                                 |
| Where is the app running?                        | `pnpm ports`                                                                             |
| Run the app                                      | `pnpm dev` (start it in the background; check `pnpm ports` first — reuse a running copy) |
| Regenerate generated files                       | `pnpm regen`                                                                             |
| One target                                       | `pnpm nx run <project>:<target>` (e.g. `pnpm nx run api:test`)                           |
| Only what changed                                | `pnpm nx affected -t lint typecheck test`                                                |
| What exists / depends on what                    | `pnpm nx show projects`, `pnpm nx show project <name> --json`                            |
| Sync agent skills after editing `.agents/skills` | `pnpm agents:sync`                                                                       |

- **pnpm only**, never npm/yarn/npx. Add dependencies with `pnpm add <pkg> --filter <project>`; versions come from the catalog in `pnpm-workspace.yaml`.
- Always run tools **through Nx** (`pnpm nx run …`), never `vitest`, `tsc`, `eslint` or `vite` directly — Nx provides the project graph, caching and the correct working directory.
- Never run `nx configure-ai-agents` (it rewrites agent config; humans run it deliberately).

<!-- kit:end -->

<!-- kit:start:navigation -->

## How to navigate (use the right graph, grep last)

- **Structure, ownership, impact** → Nx project graph: `pnpm nx show projects --affected`, `pnpm nx show project <p> --json`.
- **Definitions, callers, renames** → the TypeScript LSP (go to definition, find references, call hierarchy).
- **API shape** → `packages/graphql/schema.graphql` (generated, read-only).
- **Pages and params** → `apps/web/src/routeTree.gen.ts` (generated, read-only).
- **grep** only for strings, config values and comments.

<!-- kit:end -->

<!-- stack:start:map -->

## Repo map

| Path                  | What                                                          | Tags                        |
| --------------------- | ------------------------------------------------------------- | --------------------------- |
| `packages/validators` | Zod schemas + limits shared by api and web                    | `scope:shared`, `type:util` |
| `tools`               | dev ports, Claude Code hooks, `pnpm check`, agent-config sync | `scope:tooling`             |

<!-- stack:end -->

<!-- kit:start:invariants -->

## Invariants (enforced by lint, hooks or tests)

- **Generated files are read-only.** They are listed in `.agents/generated.json`; edit the source and run the regen command it names (or `pnpm regen`).
- **Module boundaries** (`eslint` target): `scope:web` → web/shared only; `scope:server` → server/shared only; `type:util` imports no frameworks.
- **Skills**: edit `.agents/skills/<name>/SKILL.md`, then `pnpm agents:sync` (`.claude/skills` holds generated copies).
- **Secrets**: never read or print `.env*` files; add new variables to `.env.example` and the app's env schema.

<!-- kit:end -->

<!-- kit:start:workflow -->

## Working style

- Plans and scratch notes go in `.agents/ignore/plans/YYYY-MM-DD-topic.md` (gitignored).
- Parallel work: each git worktree gets its own ports and database automatically (`pnpm ports`).
- Anything you verified by hand should become a test.

<!-- kit:end -->
