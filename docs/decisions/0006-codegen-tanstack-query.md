# 0006 — GraphQL Codegen for typed operations, TanStack Query for the cache

- **Status:** accepted (2026-09-29)
- **Applies to:** `apps/web` (`codegen.ts`, `src/gql`, `src/lib/graphql`, `src/lib/notes/queries.ts`)

## Context

The web app's operations must be typed from the API's schema, so a removed or renamed field is a
type error in the component that reads it. Pages render on the server, so the data a loader
fetches must reach the browser without a second request, and writes must refresh what they change.

## Decision

- **GraphQL Codegen** (`@graphql-codegen/cli` 7.4.3 and `client-preset` 6.2.0, pinned exactly: a
  new version can change the committed output). Operations are written with `graphql()` anywhere in
  `apps/web/src` except tests; `pnpm nx run web:codegen` types them from
  `packages/graphql/schema.graphql` into `src/gql` (committed, generated).
  - `documentMode: 'string'`: documents are typed strings, so the client bundle carries no
    graphql-js AST; fragment masking is off, so results are plain typed objects.
  - Nx runs codegen before typecheck, lint, tests and builds, and re-prints the API schema first;
    `pnpm dev` regenerates on save (`web:codegen-watch`).
- **One executor, `execute()`** (`src/lib/graphql/execute.ts`): resolves to the typed `data`, calls
  the API directly on the server and the BFF in the browser, and rejects with a
  `GraphQLRequestError` for GraphQL errors and failed answers.
- **TanStack Query 5** with `@tanstack/react-router-ssr-query`: one `QueryClient` per request,
  dehydrated into the page and hydrated in the browser. Loaders `await ensureQueryData()` and return
  nothing; components `useSuspenseQuery` the same query options; a mutation's `onSuccess` returns
  the `invalidateQueries` promise for every query it changes, keyed by a key factory (`noteKeys`).
- **`@graphql-eslint`** checks every operation against the schema in the `eslint` target, with the
  real file and line.

## Consequences

- A schema change surfaces as type errors in the operations and components it affects, in the LSP
  and in `pnpm check`: the schema graph and the symbol graph meet in `src/gql`.
- Until codegen runs, a new operation is a type error and `execute()` refuses it with a message
  naming `web:codegen`.
- No normalized cache: after a write the affected queries refetch. Simple and predictable, and
  enough for this app; a normalized cache would be a deliberate upgrade.
- `src/gql` is committed and drift-checked: a stale copy fails `pnpm check`.

## Alternatives considered

- **gql.tada**: types from TypeScript inference with no generated files; newer, and inference has
  a type-checking cost on large schemas.
- **urql**: a light client with an optional normalized cache, but no integration with Router
  loaders and SSR like TanStack Query's.
- **Apollo Client** or **Relay**: normalized caches and more machinery (Relay needs its compiler
  and conventions); more than a BFF-backed web app needs.
- **Hand-written types**: drift from the schema is then a runtime bug.
