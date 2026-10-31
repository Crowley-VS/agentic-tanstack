# 0005 — A GraphQL API: Yoga and Pothos, with the Drizzle and Relay plugins

- **Status:** accepted (2026-09-29; spike S1 passed the same day)
- **Applies to:** `apps/api`, `packages/graphql`

## Context

The API serves the web app now and is meant to serve other clients later (mobile, partners), each
needing different slices of the same data. Agents should read the API's shape from one file, have
an invalid query fail before it runs, and not write N+1 queries by accident. The API is private:
only the web server calls it.

## Decision

- **GraphQL**, code-first: the schema is TypeScript in `apps/api/src/graphql`, printed to
  `packages/graphql/schema.graphql` (committed, generated: `pnpm nx run api:print-schema`), which
  clients get their types from.
- **Pothos 4** with these plugins, in this order (`builder.ts`): Errors, Validation, Complexity,
  Relay, Dataloader, Drizzle.
  - **Drizzle** (`@pothos/plugin-drizzle` 0.20, pinned with Drizzle's release candidate): reads
    are `drizzleObject` fields, `t.relation` and `t.relatedCount`, planned into one relational SQL
    query; a test pins a page of notes with their comments and counts at one statement.
  - **Relay**: `Query.notes` is a cursor connection (`t.drizzleConnection`), ordered by creation
    time and id.
  - **Errors + Validation**: arguments are validated with the same Zod schemas as core
    (`@acme/validators`), and expected failures (`ValidationError`, `NotFoundError`) are union
    members a client selects by `__typename`, not GraphQL errors.
  - **Complexity**: every list and connection prices the rows it can return.
  - **Dataloader** is registered for batches that are not relations; nothing uses it yet.
- **Writes go through `packages/core`**, which validates again and throws domain errors; reads stay
  on the Drizzle plugin.
- **GraphQL Yoga 5** on `node:http`, locked down by default (`app.ts`, [api.md](../api.md)):
  `cors: false`, CSRF prevention, graphql-armor limits (depth, aliases, directives, tokens, cost),
  masked errors, and introspection, GraphiQL and field suggestions in development only; in
  production every request but `/health` needs `INTERNAL_API_SECRET`.
- **`graphql` 16**, pinned to one copy by a pnpm override: graphql 17 is out, but Pothos and Yoga
  are built for 16.
- **No side effects at import**: the builder and schema read no environment and open no
  connection (`client: (ctx) => ctx.db`), so `print-schema` runs with an empty environment, and a
  test proves it.

## Consequences

- The printed schema is the API's reviewable contract: a breaking change shows as a diff of
  `schema.graphql`, and `@graphql-eslint` and codegen check every web operation against it.
- Nested reads cost one statement however deep the page; a resolver that loads per row instead
  shows up as a failing statement-count test.
- Learned in the spike (S1): Pothos' plugin order matters; `timestamp(…, { precision: 3 })` on
  cursor columns (microseconds silently break page 2); `errors.unsafelyHandleInputErrors: true`
  routes validation errors into the unions; a foreign-key violation is read from
  `DrizzleQueryError.cause`; `t.loadable` on a Drizzle type adds a query.
- GraphQL is more machinery than the web app alone needs: the BFF, the printed schema and codegen
  are the price of a contract other clients can use ([why.md](../why.md)).

## Alternatives considered

- **REST + OpenAPI**: simpler, but each client's data needs become endpoints or over-fetching, and
  nested reads are hand-planned.
- **oRPC / tRPC**: excellent for TypeScript clients in the same repository; tRPC has no contract
  for non-TypeScript clients, and both serve partners less well than a schema.
- **Apollo Server**: comparable, but heavier and tied to Apollo's platform; Yoga runs on any
  runtime and ships the security plugins used here.
- **SDL-first (GraphQL Tools)**: two sources of truth for types; Pothos infers them from the code.
- **Dataloader instead of the Drizzle plugin** (S1's fallback): every relation hand-batched, and
  all reads routed through core.
