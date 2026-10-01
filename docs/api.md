# The API (`apps/api`)

Details behind the API lines of `AGENTS.md`: how to run the production bundle, the rules its code
follows, the security defaults and the error contract.

## Run the production bundle

`pnpm nx run api:build` writes the bundle the image runs. Run it from `apps/api`: `dev-ports --exec`
supplies this checkout's `DATABASE_URL` and port, and production mode needs `NODE_ENV` and a secret
(without them it runs as development):

```bash
node ../../tools/dev-ports.mjs --exec -- node dist/migrate.mjs
NODE_ENV=production INTERNAL_API_SECRET=<32+ random characters> node ../../tools/dev-ports.mjs --exec -- node dist/main.mjs
```

## The schema has no side effects at import

Nothing under `apps/api/src/graphql` reads the environment or opens a connection (the database
comes from the request context), so `print-schema` runs with an empty environment; a test enforces
it. The environment is validated once, at startup (`apps/api/src/env.ts`).

## One `graphql` copy in tests

graphql 16 has no `exports` map, so Vite and Node would load different builds and
`instanceof GraphQLError` breaks; Vitest configs that load the API alias `graphql` to Node's (see
`apps/api/vitest.config.ts`).

## Private and locked down by default

CSRF prevention, graphql-armor limits, and introspection, GraphiQL and field suggestions in
development only. In production it listens for the web server alone and requires
`INTERNAL_API_SECRET` on every request but `/health`; in development it listens on 127.0.0.1 and
ignores it (even when `.env` sets it). Tests pin each default: change one only on purpose.

The web server (`apps/web`) is the only client: its BFF (`POST /api/graphql`) and its server code
send the secret, so the browser never sees it.

## Expected failures are data

A mutation returns them as union members (`ValidationError` with `fieldErrors`, `NotFoundError`)
that clients select by `__typename`; invalid query arguments are GraphQL errors with code
`BAD_USER_INPUT`. Anything else is an unexpected error, masked. `READ_ONLY=true` makes the API
reject every mutation.
