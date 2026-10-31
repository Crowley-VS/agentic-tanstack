# Why this template, and who it is for

The template's own README has the short form. This page says who the template suits and who it
does not, why each part of the stack was chosen, and what those choices cost. Each choice has its
own decision record in [decisions/](decisions/), with the alternatives that were weighed.

## The idea

Coding agents do well in a repository that tells them, mechanically, where code goes, what a
change breaks and when they are done. They do badly in one where those answers live in people's
heads. So the template gives every rule a check, and the agent a way to ask:

- **One definition of done**, `pnpm check`, which an agent runs before it says "done" and CI runs on
  every pull request ([testing.md](testing.md)).
- **Graphs to query instead of grepping**: the Nx project graph for structure and impact, the
  TypeScript language server for symbols, and generated maps for the API, the pages and the
  operations ([agents.md](agents.md)).
- **Generated files nobody edits by hand**: hooks block the edit and name the command that
  regenerates the file ([architecture.md](architecture.md#generated-files)).
- **One reference feature** that every layer and every skill points at, so an agent copies a
  pattern instead of inventing one ([adding-a-feature.md](adding-a-feature.md)).
- **Isolation per checkout**, so several agents can work in parallel worktrees without sharing
  ports, servers or databases ([local-resources.md](local-resources.md)).

## Who it is for

**A good fit:**

1. **Teams that build mostly with coding agents** (Claude Code first; Codex and Cursor read
   `AGENTS.md` too) and want guardrails from the first commit rather than after the first mess.
2. **Data-heavy web apps with other clients planned.** The GraphQL API serves the web app now, and
   a mobile app (Expo, native) or a partner integration later, from the same typed schema. The
   business logic in `packages/core` depends on no framework. B2B SaaS, dashboards, marketplaces,
   internal tools.
3. **Teams that want type safety from the database to the page.** Drizzle types the tables,
   Pothos the API, GraphQL Codegen the operations, TanStack Router the routes and their params: a
   renamed column fails `tsc` in every layer that still uses the old name.
4. **Teams that self-host or want to avoid lock-in.** The API and the web server are plain Node
   processes in small Docker images. Railway is the documented default, and the same images run on
   any container platform.
5. **Parallel agents and worktrees.** Each checkout gets its own block of ports, its own Postgres
   container and databases, and each test file a database of its own: two agents in two worktrees
   never see each other's data or fight over a port.
6. **People setting up an agent-first repository on another stack**, as a working reference for
   `AGENTS.md`, skills, hooks, permissions and the Nx graph.

**Not a good fit:**

- **Static or content sites.** Astro or a static site generator does more with less.
- **A single, simple web app.** TanStack Start's own server functions cover it; a separate GraphQL
  API, its codegen and its BFF are overhead you would not use.
- **Teams invested in Next.js and Vercel**: Server Components, Vercel's platform features and their
  tooling are not here.
- **Apps that need auth on day one.** There is none, on purpose: auth is product-specific, and a
  half-finished default is a risk. [ADR 0012](decisions/0012-adding-auth.md) shows where it plugs
  in.
- **Heavily polyglot repositories** (Swift, Kotlin, Go or Rust services next to the TypeScript):
  moon or Bazel model those better than Nx's TypeScript-first setup here.
- **Machines without Docker, or native Windows.** Development and tests use a Postgres container
  (Docker Engine with Compose v2); package scripts assume a POSIX shell (macOS, Linux and WSL2
  work). Cloud agent sessions without Docker can run every check but the database tests:
  `pnpm nx affected -t lint eslint typecheck build`, then
  `pnpm nx affected -t test --exclude=tag:needs-db`.

## How the web app renders, and which apps that suits

The first page is rendered on the server; after that the app runs in the browser as a single-page
app, moving between pages without a reload, over one shared data cache
([ADR 0004](decisions/0004-tanstack-start.md#rendering-model-and-what-it-suits)). That is why
the web app suits interactive, app-like products (dashboards, admin and internal tools, B2B SaaS,
marketplaces: many views of the same data, a fast first view and quick navigation after it), and
why content-first sites are a poorer fit: every visit would download and hydrate the app's
JavaScript to show mostly static text, where Astro or a static site generator sends little or
none.

## Why these choices

| Choice                           | In one line                                                                                | Record                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Nx                               | The project graph, `affected`, the cache and boundaries are what agents need most          | [0002](decisions/0002-nx.md)                      |
| pnpm                             | Strict installs, one catalog of versions, a release-age delay against supply-chain attacks | [0003](decisions/0003-pnpm.md)                    |
| TanStack Start                   | Typed routes, SSR with TanStack Query, server routes, a portable Node build                | [0004](decisions/0004-tanstack-start.md)          |
| GraphQL: Yoga + Pothos           | One typed contract for many clients, nested reads in one SQL statement, secure defaults    | [0005](decisions/0005-graphql-yoga-pothos.md)     |
| GraphQL Codegen + TanStack Query | Typed operations from the printed schema; a cache that SSR fills and the browser hydrates  | [0006](decisions/0006-codegen-tanstack-query.md)  |
| Drizzle + Docker Postgres        | Typed SQL in TypeScript; the production database engine everywhere, isolated per checkout  | [0007](decisions/0007-drizzle-docker-postgres.md) |
| Tailwind 4 + shadcn/ui           | What agents know best, in component code you own                                           | [0008](decisions/0008-tailwind-shadcn.md)         |
| Vitest + Playwright              | Vite-native unit and browser tests, real-browser e2e, a browser CLI for agents             | [0009](decisions/0009-vitest-playwright.md)       |
| oxlint + oxfmt                   | Feedback in seconds; ESLint kept for the two jobs only it does                             | [0010](decisions/0010-oxlint-oxfmt.md)            |
| Docker + Railway                 | Portable images, a private API, managed Postgres, infrastructure in a reviewed file        | [0011](decisions/0011-docker-railway.md)          |
| No auth                          | Product-specific; the seams are ready                                                      | [0012](decisions/0012-adding-auth.md)             |
| The review loop                  | Why the agent PR review is shaped as it is                                                 | [0001](decisions/0001-review-loop-convergence.md) |

A few themes run through them:

- **Prefer what fails at build time.** Typed routes, typed operations, a printed schema with a
  drift check, boundaries as lint errors, a client-bundle check for server code: each turns a
  runtime surprise into a red `pnpm check`.
- **The same thing everywhere.** One Postgres major (18) and one driver from the first test to
  production; the e2e specs run on the production builds and again on the production images; CI runs
  the command developers and agents run.
- **Pin what moves.** Exact versions where compatibility is tight or a tool is pre-1.0 (Nx and its
  plugins, TypeScript, Vitest, graphql, Drizzle's release candidate, Nitro's beta, the Railway SDK),
  with a check where a bump can drift (`tools/check-versions.mjs` for Node and pnpm, the vendored
  skills' pins) and a skill for the biggest one (`nx-upgrade`).
- **Agents ask; people decide.** Everything an agent may run is listed and tested; what reaches
  outside the checkout (a push to `main`, a new dependency, a deploy) asks a human first
  ([agents.md](agents.md#permissions)).

## What it costs

- **Docker is required**, for development and tests, not only for deploys.
- **More moving parts than a single app**: two servers, a BFF, codegen and a printed schema. The
  checks keep them in step, but a small app would not need them.
- **Some pieces are pre-1.0**: Drizzle 1.0 is a release candidate, Nitro 3 a beta, and Railway's
  infrastructure-as-code SDK a beta (so `.railway/railway.ts` is marked experimental and the
  dashboard setup is documented beside it).
- **The agent layer is Claude Code first.** Other agents read `AGENTS.md` and the skills, but the
  hooks, permissions, subagents and review loop are Claude Code's.
- **No auth, no multi-tenancy, no email, no payments**: the template stops at the patterns.

## The template family

A second template, **agentic-nx-monorepo**, is planned: the same agent layer, Nx workspace and
tooling with none of this stack (no apps, API, database or deploy), for teams that bring their own.
Once it exists it becomes the upstream of the agent layer, and this template takes its updates
from it ([updating-from-template.md](updating-from-template.md)).
