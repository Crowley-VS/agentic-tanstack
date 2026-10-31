# 0004 — TanStack Start for the web app

- **Status:** accepted (2026-09-29)
- **Applies to:** `apps/web`

## Context

The web app renders on the server (fast first page, working links before hydration), talks to a
separate GraphQL API, and must keep that API's secret out of the browser. Agents write most of its
code, so a wrong link, a missing route param or a server import in client code should fail the
build, not a user.

## Decision

- **TanStack Start** (React 19; `@tanstack/react-start` 1.168, `@tanstack/react-router` 1.170,
  both pinned exactly: Start pins its router) on **Vite 8**, built by **Nitro 3** (a beta, pinned
  exactly) into a self-contained `.output` that `node .output/server/index.mjs` runs.
- **File routes** in `apps/web/src/routes`, with a generated, committed route tree
  (`routeTree.gen.ts`): links, params and search params are typed.
- **Data through TanStack Query**: loaders `await ensureQueryData()` during SSR, components read
  the same query with `useSuspenseQuery`, and the cache is dehydrated into the page
  ([0006](0006-codegen-tanstack-query.md), [web.md](../web.md)).
- **Server routes for the BFF**: `POST /api/graphql` and `/api/health` are Start server routes;
  `createIsomorphicFn` gives `execute()` a server branch (calls the API directly) and a browser
  branch (posts to the BFF).
- **Server-only code in `*.server.ts`**: Start's import protection fails a client build that
  imports one, and `web:build` then checks the client bundle for server code and the secret
  (`apps/web/scripts/check-client-bundle.mjs`).
- **Agent docs for the installed version**: the TanStack packages ship skills that
  `pnpm exec intent list` and `pnpm exec intent load <package>#<skill>` serve (TanStack Intent,
  pinned in the catalog).

## Consequences

- Typed routes and typed operations together mean a renamed page, param or field is a type error
  where it is used.
- The production server is plain Node: any container platform runs it ([0011](0011-docker-railway.md)).
- Start and Nitro 3 are young: the exact pins keep upgrades deliberate, and the tests that run the
  built server (`src/built-server.test.ts`) and the e2e specs on the production build catch what a
  bump breaks.
- No React Server Components: data comes through loaders and the GraphQL API.
- Fewer examples exist in models' training data than for Next.js; the version-matched Intent
  skills fill part of that gap.

## Alternatives considered

- **Next.js**: more training data and a devtools MCP, but it leans on Vercel's platform, and its
  Server Components and caching model add a second way to fetch data next to the API.
- **React Router (framework mode)**: close in spirit, with generated route types; TanStack
  Router's validated, typed search params and its TanStack Query SSR integration decided it.
- **A Vite SPA**: simplest, but no SSR, and the API secret would need another server anyway.
