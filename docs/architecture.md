# Architecture

How a request travels through the apps and packages, which project may import which, which files
are generated, and where things live. The details are in each area's doc; this page links them.

## The request path

```text
browser ──► web server (apps/web, TanStack Start on Nitro)
              │  pages: SSR, loaders fill the TanStack Query cache
              │  POST /api/graphql: the BFF (JSON only, 64 KB, write rate limit)
              │  GET /api/health
              │
              │  server to server: INTERNAL_API_SECRET, client IP, request id
              ▼
            API (apps/api, GraphQL Yoga + Pothos)          private: no public address
              │  /graphql, /health
              ├── reads: the Pothos Drizzle plugin, one SQL statement per query
              └── writes: packages/core (validates again, throws domain errors)
                    │
                    ▼
            Postgres 18 (packages/db: Drizzle schema, migrations)
```

- **The browser only talks to the web server.** In the browser, `execute()`
  (`apps/web/src/lib/graphql/execute.ts`) posts to the same-origin BFF,
  `src/server/graphql-proxy.server.ts`; during SSR the same `execute()` calls the API directly. Both
  go through `callInternalApi()` (`src/server/internal-api.server.ts`), which adds the secret, the
  client's IP and the request id, and forwards no browser header ([web.md](web.md#the-bff-post-apigraphql)).
- **The API is private.** It requires the secret on every request but `/health` in production,
  believes the forwarded IP and request id only with it, and has introspection and GraphiQL in
  development only ([api.md](api.md)). On Railway it has no public domain
  ([deployment-railway.md](deployment-railway.md)).
- **Reads and writes take different roads.** Reads are Drizzle relational queries planned by the
  Pothos Drizzle plugin (a page of notes with comments and counts is one statement). Writes call
  `packages/core`, which takes a `Db`, never a request, validates again with the shared Zod
  schemas, and throws domain errors that the API returns as union members
  ([0005](decisions/0005-graphql-yoga-pothos.md)).
- **One request id** ties the web server's line, the API's lines and the platform's log together
  ([production.md](production.md#request-ids-one-id-per-browser-request-in-both-servers-lines)).
- Where authentication would go in this path: [0012](decisions/0012-adding-auth.md).

## Module boundaries

Each project's tags (`package.json#nx.tags`) decide what it may import; `@nx/enforce-module-boundaries`
in the `eslint` target fails the import otherwise (`eslint.config.mjs` has the full rules).

| Project                                                      | Tags                                       | May import                                                   |
| ------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------ |
| `apps/web`                                                   | `scope:web`, `type:app`                    | `ui`, `validators`, `logger`, `graphql`                      |
| `apps/api`                                                   | `scope:api`, `type:app`, `needs-db`        | `core`, `db`, `validators`, `logger`                         |
| `apps/web-e2e`                                               | `scope:web`, `type:e2e`                    | utilities only (`type:util`)                                 |
| `packages/core`                                              | `scope:server`, `type:feature`, `needs-db` | `db`, `validators`; no React, TanStack, Yoga, Pothos or Vite |
| `packages/db`                                                | `scope:server`, `type:data`, `needs-db`    | utilities; no React, TanStack or Vite                        |
| `packages/ui`                                                | `scope:web`, `type:ui`                     | utilities                                                    |
| `packages/validators`, `packages/logger`, `packages/graphql` | `scope:shared`, `type:util`                | other utilities only; no frameworks, Drizzle or `pg`         |
| `tools`, `.railway`                                          | `scope:tooling`, `type:tooling`            | tooling only                                                 |

The scope rules: `web` → web and shared; `api` → api, server and shared; `server` → server and
shared; `shared` → shared. So the web app can never import the database or core, and the API never
imports UI. `needs-db` marks the projects whose tests need the Postgres container.

Two more boundaries are enforced outside ESLint: **server-only code** in `apps/web` lives in
`*.server.ts` files (a client import fails the build, and `web:build` checks the client bundle for
server code and the secret), and **the schema has no side effects at import** (`print-schema` runs
with an empty environment, and a test proves it).

## Generated files

Committed, marked `linguist-generated`, and never edited by hand: the edit hook blocks the edit and
names the command. `.agents/generated.json` is the list every tool reads (the hook, `pnpm regen`,
the drift gate of `pnpm check`, the formatter and linter ignores).

| Path                                                                        | Generated from                                   | Command                                                |
| --------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| `packages/graphql/schema.graphql`                                           | the Pothos schema in `apps/api/src/graphql`      | `pnpm nx run api:print-schema`                         |
| `apps/web/src/gql/**`                                                       | `schema.graphql` and the `graphql()` operations  | `pnpm nx run web:codegen` (`pnpm dev`: on save)        |
| `apps/web/src/routeTree.gen.ts`                                             | the route files in `apps/web/src/routes`         | `pnpm nx run web:generate-routes`                      |
| `packages/db/migrations/**`                                                 | `packages/db/src/schema` (drizzle-kit)           | `pnpm db:generate <what>` (once tracked, never edited) |
| `.claude/skills/**`                                                         | `.agents/skills`                                 | `pnpm agents:sync`                                     |
| `.agents/skills/{playwright-cli,drizzle,drizzle-generate,drizzle-hints}/**` | the installed packages and `.agents/vendor.json` | `node tools/vendor-skills.mjs update`                  |

`pnpm regen` runs them all; `pnpm check` fails when running them would change a committed file.
The generation chain for an API change: `print-schema` → `schema.graphql` → `codegen` →
`src/gql`, after which `tsc` flags every operation and component that still uses the old shape.

## Where things live

`AGENTS.md` ("Repo map") lists every project in a line. Inside them:

| Looking for                        | Where                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| Tables, relations, the seed        | `packages/db/src/schema/`, `relations.ts`, `seed.ts`                           |
| Input rules and limits             | `packages/validators/src/notes.ts`                                             |
| Writes and domain errors           | `packages/core/src/notes/index.ts`, `packages/core/src/errors.ts`              |
| The GraphQL schema code            | `apps/api/src/graphql/` (`builder.ts`, `notes.ts`, `errors.ts`)                |
| The API's security defaults        | `apps/api/src/app.ts`, `apps/api/src/plugins/`                                 |
| Pages and server routes            | `apps/web/src/routes/` (`api/graphql.ts`, `api/health.ts`)                     |
| Operations, query keys and options | `apps/web/src/lib/notes/queries.ts`                                            |
| Forms and components               | `apps/web/src/components/`, shadcn components in `packages/ui/src/components/` |
| Server-only web code               | `apps/web/src/server/*.server.ts`, `apps/web/src/env.server.ts`                |
| The web ↔ API contract             | `packages/validators/src/internal-api.ts` (header names, the secret's rules)   |
| e2e specs and fixtures             | `apps/web-e2e/src/`                                                            |
| Ports, URLs and database names     | `tools/dev-ports.mjs` (`pnpm ports`)                                           |
| The checks                         | `tools/check.mjs` (`pnpm check`), `.github/workflows/ci.yml`                   |
| Images and the deploy              | `apps/*/Dockerfile`, `docker-compose.stack.yml`, `.railway/railway.ts`         |
| Agent configuration                | `AGENTS.md`, `CLAUDE.md`, `.agents/`, `.claude/`, `tools/agent-hooks/`         |

## Ports and environment

Every checkout gets its own ports and database names from `tools/dev-ports.mjs`: the primary
checkout fixed defaults (web 3000, API 4000, Postgres 5432), each linked worktree its own block;
environment variables (`WEB_PORT`, `API_PORT`, `DB_PORT`, …) override them, and `.env` holds no
ports. `pnpm ports` prints them. Secrets and settings come from `.env` (Nx loads it into every
task), validated at startup by each app's schema (`apps/api/src/env.ts`, `apps/web/src/env.server.ts`).
What each variable does in production: [deployment.md](deployment.md#what-the-images-expect-at-runtime).
