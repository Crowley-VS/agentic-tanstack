# The API (`apps/api`)

Details behind the API lines of `AGENTS.md`: how to run it, the rules its code follows, the
security defaults and the error contract.

## Run it

| Task                                    | Command                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| Dev server (migrates first; reloads)    | `pnpm nx run api:dev` (GraphiQL at the printed URL), or `pnpm dev` with the web app  |
| Change the schema                       | edit `apps/api/src/graphql/*`, then `pnpm nx run api:print-schema` (or `pnpm regen`) |
| Production bundle (what the image runs) | `pnpm nx run api:build`, then run it as below                                        |

GraphQL answers at `/graphql`, the health check at `/health` (an empty 200); `pnpm ports` prints
the URL.

## Run the production bundle

`pnpm nx run api:build` writes the bundle the image runs. Run it from `apps/api`: `dev-ports --exec`
supplies this checkout's `DATABASE_URL` and port, and production mode needs `NODE_ENV` and a secret
(without them it runs as development):

```bash
node ../../tools/dev-ports.mjs --exec -- node dist/migrate.mjs
NODE_ENV=production INTERNAL_API_SECRET=<32+ random characters> node ../../tools/dev-ports.mjs --exec -- node dist/main.mjs
```

Production mode listens on `::` (every interface); add `LISTEN_HOST=127.0.0.1` to keep it on this
machine.

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
development only. In production it listens on `::` for the web server alone and requires
`INTERNAL_API_SECRET` on every request but `/health`; in development it listens on 127.0.0.1 and
ignores it (even when `.env` sets it). `LISTEN_HOST` overrides the address in either mode. Tests
pin each default: change one only on purpose.

The web server (`apps/web`) is the only client: its BFF (`POST /api/graphql`) and its server code
send the secret, so the browser never sees it.

## Expected failures are data

A mutation returns them as union members (`ValidationError` with `fieldErrors`, `NotFoundError`)
that clients select by `__typename`; invalid query arguments are GraphQL errors with code
`BAD_USER_INPUT`. Anything else is an unexpected error, masked. `READ_ONLY=true` makes the API
reject every mutation with code `READ_ONLY`; `Query.readOnly` tells clients beforehand. The codes
clients act on are shared constants (`@acme/validators/error-codes`).

## One log line per request

`[api] <status> <method> <path> <ms>ms ip=<client> id=<request id>` (`plugins/request-log.ts`;
health checks are not logged). A request may carry the browser's IP (`x-client-ip`) and a request
id (`x-request-id`) from the web server; the API believes them only when its secret matches (in
development too, when a secret is set), else it logs the socket's address and `id=-`. The header
names and the secret's rules are shared with the web server (`@acme/validators/internal-api`).
