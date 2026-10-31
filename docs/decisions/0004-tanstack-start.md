# 0004 — TanStack Start for the web app

- **Status:** accepted (2026-09-29); amended 2026-10-31 (Rendering model, and what it suits)
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

## Rendering model, and what it suits

- **Every full page load renders on the server** (the first visit, a reload, a shared link).
  Start's server (on Nitro) runs the loaders of the matched routes (the root's and the page's),
  which fill a query cache for that request, and the HTML arrives complete: a fast first view,
  readable by crawlers, with links that work before the JavaScript loads. The cache travels in the
  page.
- **After that it is a single-page app.** The browser takes over that cache without refetching it
  (`staleTime` 30 s, `apps/web/src/router.tsx`), and TanStack Router navigates without reloading
  the page: a link runs the next route's loaders in the browser, which fetch through the BFF only
  what the cache lacks (hovering a link already preloads it); a query older than 30 s shows at
  once and refreshes in the background. In the browser every page shares one cache, and a write
  refetches only the queries that show what it changed.

This suits **interactive, app-like UIs**, where one visit moves through many views of the same
data and acts on it: dashboards, admin and internal tools, B2B SaaS, marketplaces. The server render
makes the first view fast; client-side navigation and the shared cache make every view after it
quick, with no new page from the server.

It suits **content-first sites** less (blogs, documentation, marketing pages, where most visits
read one page): every visit downloads and hydrates the app's JavaScript to show mostly static
text. Astro (static HTML with islands of JavaScript) or a static site generator sends little or
none there, and React Server Components (Next.js) leave the code of components that only render
content out of the bundle. Editors with frequent saves fit less well as built: writes have no
optimistic updates and wait for their refetch, and the BFF limits writes per client
(`docs/web.md`).

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
