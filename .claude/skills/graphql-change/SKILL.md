---
name: graphql-change
description: 'Use when changing the GraphQL API shape in apps/api/src/graphql: a type, field, argument, query, mutation or error. Gives the order (Pothos, print-schema, web codegen), the error and security rules, how to change a field deployed clients use, and the tests that prove it.'
---

# Change the GraphQL API

Read `docs/api.md` first. The schema is Pothos code in `apps/api/src/graphql`;
`packages/graphql/schema.graphql` is printed from it, and the web app's operation types
(`apps/web/src/gql`) are generated from that. A new field from the database up follows skill
`add-feature`; a schema change under it, skill `db-migration`.

## 1. Edit the Pothos schema

- `apps/api/src/graphql/notes.ts` is the reference. A new module is imported in
  `apps/api/src/graphql/schema.ts`. Nothing under `apps/api/src/graphql` reads the environment or
  opens a connection at import: the database comes from the request context (`ctx.db`), and a test
  prints the schema with an empty environment.
- Reads use the Drizzle plugin (`builder.drizzleObject`, `t.relation`, `t.relatedCount`,
  `t.drizzleConnection`), which plans a nested query as one SQL statement.
- Writes are mutations that call `packages/core`, which validates again and throws domain errors;
  a resolver never writes with Drizzle itself. Pass the input's Zod schema from
  `packages/validators` as `validate:`, so the API and the web form share rules and messages.
- Expected failures are data: a mutation lists them in `errors: { types: [...] }`, and clients
  select them by `__typename`. A new one is a class in `packages/core/src/errors.ts`, registered in
  `apps/api/src/graphql/error-types.ts`; never throw it as a GraphQL error.
- Price what can return many rows: a connection prices its page (as `notes` does), a list relation
  its limit (`comments`). `complexity.test.ts` fails for a connection that does not.

## 2. Regenerate

- `pnpm nx run api:print-schema` rewrites `packages/graphql/schema.graphql`. Read its diff: it is
  the contract clients compile against.
- `pnpm nx run web:codegen` regenerates `apps/web/src/gql` (it prints the schema first;
  `pnpm dev` does both on save).
- `pnpm nx run web:typecheck` and `pnpm nx run web:eslint`: the eslint target checks every
  `graphql()` operation in `apps/web/src` against the new schema, deprecated fields included.
- Never edit either output by hand (`.agents/generated.json`).

## 3. Deployed clients: add, deprecate, then remove

The API and the web server deploy separately, and open browser tabs keep running the old web code,
so for a while old operations meet the new schema.

- Add freely: a type, a field, a query or mutation, an optional argument or input field.
- Never rename or remove a field, argument or enum value, or make an input required, in one
  change. Add the replacement and mark the old one `deprecationReason: 'Use x'` (it prints as
  `@deprecated` in `schema.graphql`); move every operation in `apps/web/src` to the replacement in
  the same PR (`web:eslint` fails on an operation that selects a deprecated field). Remove the old
  one in a later PR, after a deploy.
- A new union member reaches old clients too: the forms' exhaustive `__typename` switch shows a
  generic message for one it does not know (`docs/web.md`, "Writes: forms").

## 4. Security defaults and tests

- The API is private and locked down by default: CSRF prevention, graphql-armor limits,
  introspection and GraphiQL in development only, the internal secret in production.
  `apps/api/src/app.test.ts` pins each default: change one only on purpose, with its test.
- `READ_ONLY=true` rejects every mutation, a new one included (`plugins/read-only.ts`), and the
  BFF's write rate limit counts each mutation root field (`docs/web.md`).
- Tests go in `apps/api/src/graphql/*.test.ts`, through `yoga.fetch` with `testDb()` (copy
  `notes.test.ts`): the field in a query, the mutation storing it, its `ValidationError`
  (`fieldErrors` with `path: ['input', 'x']`) and every other union member.
- Add a new relation, count or resolver-backed field to the query of the one-SQL-statement test in
  `notes.test.ts`: it catches an N+1 only in what it selects.
- `apps/api/src/main.test.ts` fails while `schema.graphql` is stale.

## 5. Prove it

- `pnpm regen`, then `git status`: `schema.graphql` and `apps/web/src/gql` changed only through
  their commands, and are in the change.
- `pnpm check`, and `pnpm nx e2e web-e2e` (an API change; skill `e2e-test`).
- Run it (skill `run-web`): the operation through the BFF with curl, then the page that uses it.
