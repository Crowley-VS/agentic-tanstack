---
name: run-web
description: "Use when you need to run the app and see a change work: the dev servers, their health checks, a GraphQL query through the same-origin BFF with curl, the production build, or the production images. Gives this checkout's URLs and commands, and how to stop everything you started."
---

# Run the app and see it work

Each checkout (each git worktree) has its own ports and database: `pnpm ports` prints its URLs.
Docker must run. Details: `docs/web.md` and `docs/api.md`, "Run it".

## 1. The dev servers

- `pnpm db:seed` if you need data (it starts and migrates the database first).
- `pnpm dev` in the background: web and API, reloading; it migrates the database first and
  regenerates the operation types on save. Each request logs one line per server, such as
  `[web] 200 POST /api/graphql 19ms …`.
- Wait until both answer, then check them. The API's health check answers 200 with an empty body:

```bash
WEB=$(node tools/dev-ports.mjs --get web)
API=$(node tools/dev-ports.mjs --get api)   # ends in /graphql
curl -fsS "$WEB/api/health"                                          # {"status":"ok","version":"dev"}
curl -fsS -o /dev/null -w "%{http_code}\n" "${API%/graphql}/health"  # 200
```

## 2. A GraphQL query through the BFF

The browser reaches the API only through the web server's same-origin `POST /api/graphql` (JSON
only). Copy a real operation from `apps/web/src/lib/notes/queries.ts`:

```bash
curl -sS -H 'content-type: application/json' \
  --data '{"query":"query Notes($first: Int) { notes(first: $first) { edges { node { id title commentCount } } } }","variables":{"first":2}}' \
  "$WEB/api/graphql"
```

- Expected failures come back as data (`"__typename":"ValidationError"` with `fieldErrors`), not
  as `errors`.
- Writes are rate-limited in dev too (`WRITE_RATE_LIMIT`, `docs/web.md`): a 429 with
  `RATE_LIMITED` says so. For scripted writes, start the servers with
  `WRITE_RATE_LIMIT=off pnpm dev`.
- Test through the BFF, not the API's port: in production only the web server reaches the API,
  with a secret.
- A page: the server-rendered HTML holds the loaders' data, so after `pnpm db:seed`,
  `curl -fsS "$WEB/" | grep -ao 'Seed note [0-9]*' | head -1` prints the newest seed note (`-a`:
  grep calls the page binary; the seed's titles: `SEED` in `apps/web-e2e/src/fixtures.ts`).
- A page in a real browser, hydrated (skill `playwright-cli`):
  `pnpm exec playwright cli open --browser=chromium`, then
  `pnpm exec playwright cli goto <web URL>` (from `pnpm ports`) and
  `pnpm exec playwright cli snapshot`: the board, as roles and names with refs (after
  `pnpm db:seed`, the newest seed note comes first). Against `pnpm dev` the first snapshot can
  come before hydration, with every button `[disabled]`: snapshot again once one is enabled.
  `find "Seed note"` searches it; `click <ref>`, `fill <ref> "<text>"`, `console` and `requests`
  act on and inspect the page. Each write it makes counts against the dev rate limit.

## 3. The production build

When SSR, the build or production settings matter, `pnpm dev` is not enough:

- `pnpm nx run-many -t serve-e2e -p api web` in the background: both production builds
  (`NODE_ENV=production`, the internal secret enforced) on the e2e ports, against the e2e
  database, freshly seeded. Check `curl -fsS "$(node tools/dev-ports.mjs --get webE2e)/api/health"`
  and query its BFF as above; the API's own port answers 401 without the secret. Stop it before
  any `pnpm nx e2e web-e2e`, which would reuse it (`docs/e2e.md`).
- The images, after a change to a Dockerfile, `.dockerignore` or `docker-compose.stack.yml`:
  `pnpm nx run web-e2e:stack-up` builds and starts them with their own empty Postgres (web on
  "stack web" from `pnpm ports`); `pnpm nx run web-e2e:stack-down` removes them.
  `docs/deployment.md` shows how to seed and look inside, and `pnpm nx run web-e2e:e2e-stack` runs
  every spec against them.

## 4. Stop what you started

- Stop each server you started (its background task), then check that its health URL no longer
  answers. Close a browser you opened: `pnpm exec playwright cli close-all`, then
  `pnpm exec playwright cli list` shows none open.
- `pnpm teardown` before you leave or delete a worktree: it stops this checkout's Postgres and Nx
  daemon (data kept) and removes its image stack. Skip it while a server you did not start (the
  user's `pnpm dev`) still runs here (`docs/local-resources.md`).
