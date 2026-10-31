# acme-app

An Nx monorepo created from the [agentic-tanstack](https://github.com/Crowley-VS/agentic-tanstack) template
(provenance: `package.json#template`), set up so coding agents can work in it reliably: a TanStack Start web
app, a private GraphQL API (Yoga + Pothos), Drizzle and Postgres 18 in Docker.

## Prerequisites

Node 24 (`.node-version`), pnpm 11 (`package.json#packageManager`), Docker Engine with Compose v2 (running:
development and tests use a Postgres container per checkout), and git. macOS, Linux or WSL2.

## Getting started

```bash
test -f .env || cp .env.example .env   # a fresh clone: then set the values it lists; never commit .env
pnpm install # also installs the git hooks (lefthook): format + lint staged files, keep agent config in sync
pnpm check   # the definition of done: lint, formatting, module boundaries, typecheck, tests, generated files, agent config
pnpm ports   # this checkout's ports and database URLs (every git worktree gets its own;
             # another project on this machine holds them? .ports.local: docs/troubleshooting.md)
pnpm dev     # web + API, reloading; curl the web's /api/health and the API's /health
node tools/setup-agents.mjs   # once per machine: the Claude Code plugins this repo enables, and what they need
```

Each checkout runs its own Postgres container and Nx daemon. Before deleting a worktree, run
`pnpm teardown` in it (stops both, keeps the data, removes its production-image stack);
`pnpm prune:orphans` removes what already deleted worktrees left behind. See
[docs/local-resources.md](docs/local-resources.md).

Agents and humans follow the same rules: see [AGENTS.md](AGENTS.md) (Claude Code reads it through `CLAUDE.md`).
How the agent setup works (skills, subagents, plugins, permissions, opt-ins): [docs/agents.md](docs/agents.md).

## Docs

| Doc                                                                                                | For                                                  |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)                                                       | the request path, module boundaries, generated files |
| [docs/adding-a-feature.md](docs/adding-a-feature.md)                                               | the order of layers for a new field or feature       |
| [docs/testing.md](docs/testing.md)                                                                 | every kind of test, and what `pnpm check` and CI run |
| [docs/web.md](docs/web.md), [docs/api.md](docs/api.md), [docs/database.md](docs/database.md)       | each area: how to run it, its rules                  |
| [docs/e2e.md](docs/e2e.md)                                                                         | the Playwright specs                                 |
| [docs/deployment.md](docs/deployment.md), [docs/deployment-railway.md](docs/deployment-railway.md) | the Docker images, Railway                           |
| [docs/production.md](docs/production.md)                                                           | logs, versions, request ids, shutdown                |
| [docs/troubleshooting.md](docs/troubleshooting.md)                                                 | Docker, ports, leftovers, browsers, Nx, `.env`       |
| [docs/why.md](docs/why.md), [docs/decisions/](docs/decisions/)                                     | why the stack is what it is                          |
| [docs/updating-from-template.md](docs/updating-from-template.md)                                   | taking later template changes                        |

There is no authentication: the Notes board is a public reference feature that anyone can read and write to. Add auth before you rely
on public writes: [docs/decisions/0012-adding-auth.md](docs/decisions/0012-adding-auth.md).
