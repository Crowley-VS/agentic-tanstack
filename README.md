# agentic-tanstack

A GitHub template for a full-stack TypeScript monorepo that coding agents (Claude Code first) can
work in reliably from the first clone: **Nx**, **TanStack Start**, a **GraphQL** API (Yoga +
Pothos), **Drizzle** and **Postgres 18** in Docker, one working reference feature, and an agent
layer that holds every change to one definition of done.

## What it is

- **A web app and a private API.** `apps/web` is TanStack Start (React 19, SSR on Nitro, Tailwind 4
  and shadcn/ui). The browser only ever calls its same-origin BFF (`POST /api/graphql`), which
  forwards to `apps/api`, a GraphQL API that has no public address.
- **Logic in plain packages.** Writes and domain errors live in `packages/core`, which takes a
  database handle and never a request; the apps are thin wrappers around it.
- **Types end to end.** Drizzle schema → Pothos schema → printed `schema.graphql` → typed
  operations from GraphQL Codegen → typed routes and params from TanStack Router. Most mistakes
  fail `tsc` before anything runs.
- **One definition of done.** `pnpm check` runs lint, formatting, module boundaries, typecheck,
  unit, database and browser tests, builds, generated-file drift and the agent-config checks, on
  the projects a change affects. CI runs the same command.
- **An agent layer.** `AGENTS.md`, task skills, subagents, hooks that guard generated files,
  reviewed permissions and a PR review loop: [How agents work here](#how-agents-work-here).

## Who it's for

**A good fit:**

1. **Teams that build mostly with coding agents** (Claude Code, Codex, Cursor) and want guardrails
   from the first commit: one "done" command, generated files agents cannot hand-edit, graphs they
   can query, and skills that point at a real example to copy.
2. **Data-heavy web apps with other clients planned** (mobile, partners): the GraphQL API serves
   the web now and other clients later, and the core logic stays framework-free. B2B SaaS,
   dashboards, marketplaces, internal tools.
3. **Teams that want type safety from the database to the page.**
4. **Teams that self-host or avoid platform lock-in.** Both servers are plain Node in Docker images;
   Railway is the documented default, not a requirement.
5. **Parallel agents and git worktrees.** Every checkout gets its own ports, its own Postgres
   server and its own databases, and every test file its own database.
6. **A reference** for setting up an agent-first repository (AGENTS.md, skills, hooks, the Nx
   graph) on another stack.

**Not a good fit:**

- **Static or content sites**: use Astro or a static site generator.
- **A single, simple web app**: TanStack Start's server functions alone are enough; a GraphQL API
  is overhead there.
- **Teams invested in Next.js and Vercel** (Server Components, Vercel's platform features).
- **Apps that need auth on day one**: there is none, on purpose
  ([ADR 0012](docs/decisions/0012-adding-auth.md) shows where it plugs in).
- **Heavily polyglot repositories** (Swift, Kotlin, Go or Rust services): moon or Bazel suit them
  better.
- **Machines without Docker, or native Windows.** Postgres runs in Docker for development and
  tests; macOS, Linux and WSL2 are supported.

The longer version, with what each choice costs: [docs/why.md](docs/why.md).

## Why this stack

| Choice                                  | Why                                                                                                                                                      | Instead of                                     | ADR                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------ |
| **Nx** (+ `configure-ai-agents`)        | A project graph agents can query; `affected` runs only what a change touches; cached tasks; module boundaries as lint errors; Nx's agent skills          | Turborepo, moon                                | [0002](docs/decisions/0002-nx.md)                      |
| **pnpm 11**                             | Strict installs (no undeclared dependencies); one catalog, one version per dependency; `minimumReleaseAge` holds back day-old releases                   | npm, Yarn, Bun                                 | [0003](docs/decisions/0003-pnpm.md)                    |
| **TanStack Start** (Vite, Nitro)        | Type-safe routes and params, SSR with TanStack Query, server routes for the BFF, a plain Node build; agent skills matched to the installed version       | Next.js                                        | [0004](docs/decisions/0004-tanstack-start.md)          |
| **GraphQL: Yoga + Pothos**              | One typed contract for every client; a code-first TypeScript schema whose Drizzle plugin loads nested data in one SQL statement; Yoga's security plugins | REST/OpenAPI, oRPC, tRPC                       | [0005](docs/decisions/0005-graphql-yoga-pothos.md)     |
| **GraphQL Codegen + TanStack Query**    | Operations typed from the printed schema, regenerated by Nx; Query's cache filled by Router loaders during SSR                                           | gql.tada, urql, Apollo Client                  | [0006](docs/decisions/0006-codegen-tanstack-query.md)  |
| **Drizzle + Postgres 18 in Docker**     | Typed, SQL-like queries in plain TypeScript; the same Postgres and driver in development, tests, e2e and production                                      | PGlite (dropped after a spike), Prisma, SQLite | [0007](docs/decisions/0007-drizzle-docker-postgres.md) |
| **Tailwind 4 + shadcn/ui**              | What agents know best; the component code is yours, in `packages/ui`                                                                                     | component libraries you cannot edit            | [0008](docs/decisions/0008-tailwind-shadcn.md)         |
| **Vitest + Playwright** (+ its CLI)     | Vite-native unit and browser tests; e2e on the production builds; a token-cheap browser CLI for agents                                                   | Jest, Cypress, Playwright MCP                  | [0009](docs/decisions/0009-vitest-playwright.md)       |
| **oxlint + oxfmt** (+ ESLint, narrowly) | Lint and format in seconds; ESLint only for module boundaries and GraphQL operations                                                                     | ESLint + Prettier alone                        | [0010](docs/decisions/0010-oxlint-oxfmt.md)            |
| **Docker + Railway** (IaC experimental) | Small portable images; a private API behind the web server; managed Postgres 18; the infrastructure in a reviewed file                                   | Vercel, Fly.io, Render                         | [0011](docs/decisions/0011-docker-railway.md)          |
| **No auth**                             | Auth is product-specific, and a half-finished one is a risk; the ADR shows where it plugs in                                                             | a default auth everyone must replace or trust  | [0012](docs/decisions/0012-adding-auth.md)             |

## Quickstart

**You need:** Node 24 (`.node-version` pins the exact version), pnpm 11
(`package.json#packageManager`: `corepack enable pnpm`, or `proto install` with `.prototools`),
Docker Engine with Compose v2, running, and git with a user name and email. macOS, Linux or WSL2.

**1. Get a copy** (bootstrap refuses to run in a clone of the template itself):

- **GitHub:** "Use this template" → "Create a new repository", then clone your new repository.
- **A tarball:** no git history; bootstrap runs `git init -b main`.

  ```bash
  curl -fsSL https://github.com/Crowley-VS/agentic-tanstack/archive/refs/heads/main.tar.gz | tar -xz
  mv agentic-tanstack-main my-app && cd my-app
  # or, from a clone of the template: git archive --prefix=my-app/ HEAD | tar -x -C ..
  ```

**2. Bootstrap it:**

```bash
node scripts/bootstrap.mjs                                  # asks for the scope and the name
node scripts/bootstrap.mjs --yes --scope @my-org --name my-app   # or asks nothing
```

It renames the `@acme/…` packages and the `acme-app` placeholder, writes `.env` with a generated
`INTERNAL_API_SECRET`, removes the template-only files (and their allow rules in
`.claude/settings.json`) and swaps in the project README, records the
template version in `package.json#template`, installs (dependencies, git hooks, Chromium),
regenerates and formats what it touched, commits, and deletes itself. Every step checks its own
result first, so a failed run can be re-run.

| Option                            | What it does                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `-y`, `--yes`                     | never ask (needs `--scope` and `--name`)                                         |
| `--scope <@scope>`                | npm scope of the internal packages, e.g. `@my-org`                               |
| `--name <name>`                   | project name: lowercase letters, digits and dashes                               |
| `--repo <owner/repo>`             | the GitHub repository Railway deploys (default: the origin remote, else a guess) |
| `--license keep\|replace\|delete` | the LICENSE (default: ask; `replace` with `--yes`: MIT with your name)           |
| `--author <name>`                 | copyright holder of a replaced LICENSE (default: git `user.name`)                |
| `--dry-run`                       | print what would change, write nothing                                           |
| `--force`                         | run even though the origin is the template repository                            |
| `--no-install`                    | skip the install, regeneration and git hooks                                     |
| `--no-browsers`                   | skip the Playwright Chromium download                                            |
| `--no-commit`                     | leave the changes uncommitted                                                    |
| `--keep-script`                   | keep `scripts/bootstrap.*`                                                       |

Its commit is the project's first and belongs on `main`: the one commit made there directly, so
create your feature branches after it. If your rules need a PR or commit trailers for it, pass
`--no-commit` and commit it yourself.

**3. Run it:**

```bash
pnpm ports                    # this checkout's URLs, ports and database URLs
pnpm dev                      # web + API, reloading (starts and migrates Postgres first)
pnpm db:seed                  # optional: the reference feature's sample data
pnpm check                    # the definition of done
node tools/setup-agents.mjs   # once per machine: the Claude Code plugins this repo enables
```

Then start `claude` at the repository root and trust the folder ([docs/agents.md](docs/agents.md)).
Something fails? [docs/troubleshooting.md](docs/troubleshooting.md).

## What you get

| Project               | What it holds                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `apps/web`            | TanStack Start: pages, the BFF (`/api/graphql`), `/api/health`, browser tests ([docs/web.md](docs/web.md)) |
| `apps/api`            | The GraphQL API: Notes queries and mutations, locked-down defaults ([docs/api.md](docs/api.md))            |
| `apps/web-e2e`        | Playwright specs on the production builds and on the images ([docs/e2e.md](docs/e2e.md))                   |
| `packages/core`       | Business logic: writes and domain errors                                                                   |
| `packages/db`         | Drizzle schema, migrations, seed, per-test-file databases ([docs/database.md](docs/database.md))           |
| `packages/graphql`    | `schema.graphql`, the printed API contract                                                                 |
| `packages/validators` | Zod schemas and limits shared by the API and the web app                                                   |
| `packages/logger`     | One log line per event, JSON in production ([docs/production.md](docs/production.md))                      |
| `packages/ui`         | shadcn/ui components and the Tailwind 4 theme                                                              |
| `tools`               | Dev ports, `pnpm check`, Claude Code hooks, agent-config sync, machine setup                               |
| `.railway`            | Railway infrastructure as code (experimental)                                                              |

**The reference feature, a Notes board:** a public, create-only board of notes with comments.
It crosses every layer (table and migration, Zod validators, core writes, a Relay connection and
two mutations whose expected failures are union members, an SSR page with "Load more", forms,
browser and e2e tests), and every skill points at it as the pattern to copy. It ships with a write
rate limit and a `READ_ONLY=true` switch, because anyone can write to it.

**The checks:** `pnpm check` runs its gates on the affected projects (`--all` for every project):
agent config, generated-file drift, oxlint, ESLint (module boundaries, GraphQL operations),
typecheck, tests (unit, API, database, browser), builds, Nx sync, formatting, pinned versions and
the relative links in the Markdown files.
CI runs it, then the e2e specs (`e2e-ci`, one task per spec file) and, when web or api changed, the
production images: built, started together, checked (production mode, non-root, the API's secret,
the version, SIGTERM) and tested with every e2e spec. How the tests are organized:
[docs/testing.md](docs/testing.md). How the pieces fit: [docs/architecture.md](docs/architecture.md).

## How agents work here

Agents read `AGENTS.md` (Claude Code through `CLAUDE.md`): what "done" means, the commands, the
invariants, and which doc to read before touching an area. The machinery around it:

- **Three graphs, grep last.** Structure and impact from the Nx project graph
  (`pnpm nx show projects --affected`); definitions, callers and renames from the TypeScript LSP;
  the API, the pages and the operations from generated maps (`packages/graphql/schema.graphql`,
  `apps/web/src/routeTree.gen.ts`, `apps/web/src/gql`). grep is for strings and config values.
- **Skills** (`.agents/skills`, copied to `.claude/skills` by `pnpm agents:sync`): one per task,
  with its steps, commands and checks: `add-feature`, `db-migration`, `graphql-change`,
  `e2e-test`, `add-ui-component`, `run-web`, `verify`, `nx-upgrade`, `review-loop`. Plus vendored
  upstream skills with this repo's commands (`playwright-cli`, `drizzle`, `drizzle-generate`,
  `drizzle-hints`), and the skills the installed TanStack packages ship, through TanStack Intent.
- **Subagents** (`.claude/agents`): `reviewer`, a read-only review against the `AGENTS.md`
  invariants (file, line, rule), and `db-migrations`, a schema change and its migration.
- **Hooks:** edits to generated files are blocked with the command that regenerates them; edited
  files are formatted; opening a PR offers the review loop. Git hooks format, lint and sync on
  every commit.
- **The review loop** (skill `review-loop`): reviewers and a hands-on tester review a PR, post
  inline findings, fix the blocker and major ones and check the fixes; a human merges. Why it is
  shaped this way: [ADR 0001](docs/decisions/0001-review-loop-convergence.md).
- **Permissions** (`.claude/settings.json`, pinned by tests): the checks, regeneration, the dev
  servers and e2e run without asking; pushes to `main`, force pushes, new dependencies and every
  Railway command ask a human; reading `.env*`, `npx` and edits to generated files are denied.

Setup, trust, plugins, opt-ins (CodeGraph, Apollo MCP, Playwright's test agents) and the full
permission list: [docs/agents.md](docs/agents.md).

## Deploying

1. **Docker images** (`apps/api/Dockerfile`, `apps/web/Dockerfile`): Node 24 slim plus a few MB of
   bundled app, non-root, graceful on SIGTERM. `pnpm nx run web-e2e:e2e-stack` runs every e2e spec
   against them on your machine: [docs/deployment.md](docs/deployment.md).
2. **Railway**: Postgres 18, the private API and the public web server, from
   `.railway/railway.ts` (Railway's TypeScript SDK, a beta: experimental) or set up in the
   dashboard by hand: [docs/deployment-railway.md](docs/deployment-railway.md). The images run on
   any platform that runs containers; logs, versions and shutdown: [docs/production.md](docs/production.md).

**To try it first:**
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/QpDtjR?referralCode=EtCzOy)
deploys this repository as it is, into your Railway account and on its bill
([what it costs](docs/deployment-railway.md#what-it-costs)): the Notes board, which anyone can
write to (rate-limited; `READ_ONLY=true` on the api stops writes) and has no auth. It runs this
repository's code, not yours: to change the code, **Eject** the services into your own GitHub copy
([docs/deployment-railway.md](docs/deployment-railway.md#the-deploy-on-railway-button)).

## Docs

| Doc                                                                                                                                          | For                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [docs/why.md](docs/why.md), [docs/decisions/](docs/decisions/)                                                                               | who it is for, and the reasons behind each choice    |
| [docs/architecture.md](docs/architecture.md)                                                                                                 | the request path, module boundaries, generated files |
| [docs/adding-a-feature.md](docs/adding-a-feature.md)                                                                                         | the order of layers for a new field or feature       |
| [docs/testing.md](docs/testing.md)                                                                                                           | every kind of test, and what `pnpm check` and CI run |
| [docs/web.md](docs/web.md), [docs/api.md](docs/api.md), [docs/database.md](docs/database.md), [docs/e2e.md](docs/e2e.md)                     | each area: how to run it, its rules                  |
| [docs/deployment.md](docs/deployment.md), [docs/deployment-railway.md](docs/deployment-railway.md), [docs/production.md](docs/production.md) | images, Railway, runtime                             |
| [docs/agents.md](docs/agents.md), [docs/local-resources.md](docs/local-resources.md)                                                         | the agent setup; what a checkout leaves running      |
| [docs/updating-from-template.md](docs/updating-from-template.md)                                                                             | taking later template changes into your project      |
| [docs/troubleshooting.md](docs/troubleshooting.md)                                                                                           | Docker, ports, leftovers, browsers, Nx, `.env`       |

## The template family

- **agentic-tanstack** (this repository): the agent layer plus the full stack and the Notes
  reference feature.
- **agentic-nx-monorepo** (planned): the same agent layer, Nx workspace and tooling without the
  stack (no apps, API, database or deploy), for teams that bring their own. Once it exists, this
  template will take its agent-layer updates from it.

## Contributing

Proposals and fixes to the template are welcome: [CONTRIBUTING.md](CONTRIBUTING.md). Report
vulnerabilities privately: [SECURITY.md](SECURITY.md). Everyone taking part follows the
[Code of Conduct](CODE_OF_CONDUCT.md). Releases: [CHANGELOG.md](CHANGELOG.md).

## Licence

MIT: [LICENSE](LICENSE). One exception: the vendored agent skills in
`.agents/skills/playwright-cli`, `.agents/skills/drizzle`, `.agents/skills/drizzle-generate` and
`.agents/skills/drizzle-hints` (and their copies in `.claude/skills`) are third-party text under
the Apache License 2.0, from Playwright and drizzle-kit. Their notices are in
[`.agents/vendor/`](.agents/vendor/): keep them when you redistribute the skills.
