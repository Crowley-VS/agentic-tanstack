# Production images (`apps/*/Dockerfile`)

Details behind the deployment lines of `AGENTS.md`: what the two images hold, how to build them,
how to run them together on this machine and test them there, the CI job that does the same, and
what they expect from the platform.

## Two images, built from the repository root

| Image | Dockerfile            | Runs                            | Holds                                   | Port |
| ----- | --------------------- | ------------------------------- | --------------------------------------- | ---- |
| api   | `apps/api/Dockerfile` | `node dist/main.mjs`            | the tsdown bundle (`dist/`), migrations | 4000 |
| web   | `apps/web/Dockerfile` | `node .output/server/index.mjs` | Nitro's `.output`                       | 3000 |

The api image also applies the migrations, before a deploy: `node dist/migrate.mjs`. Both are
`node:24.21.0-trixie-slim` plus a few MB of app: no `node_modules`, no package manager, no build
tools. The build context is the repository root (`.dockerignore` sends only what a build
reads: never `node_modules`, builds, `.env*`, `.git` or agents' worktrees, but every workspace
package's `package.json`, which the frozen install needs), and the first stage installs the
workspace and runs the app's Nx `build` alone (`--excludeTaskDependencies`: the generated files are
committed). The stages up to the install are the same lines in both files, so the two builds share
those layers. Nx loads every project's configuration to build its graph, the e2e and agent tooling
included (`eslint.config.mjs` reads `.agents/generated.json`): a config that fails to load breaks
the images too. So `apps/web-e2e/playwright.config.mts` throws only in a task, never while Nx
infers the targets, whatever `BASE_URL` the environment holds.

| Task                                   | Command                                                         |
| -------------------------------------- | --------------------------------------------------------------- |
| Build one image                        | `pnpm nx run api:docker-build` / `pnpm nx run web:docker-build` |
| Run both on this machine (prod-like)   | `pnpm nx run web-e2e:stack-up` (builds both first)              |
| Every e2e spec against them, then down | `pnpm nx run web-e2e:e2e-stack` (below)                         |
| Remove that stack, its data and images | `pnpm nx run web-e2e:stack-down` (`pnpm teardown` runs it too)  |
| Plain Docker (CI, a platform)          | `docker build -f apps/api/Dockerfile .` from the root           |
| The same, with the version it reports  | add `--build-arg APP_VERSION=<version>` (`docs/production.md`)  |

Docker's layer cache makes a rebuild cheap unless the lockfile changed: after a source change each
image rebuilds in about 3 s; after a change to a file `.dockerignore` leaves out (docs, Markdown,
agent config), nothing rebuilds. A changed lockfile (or an empty cache) reinstalls everything: about
50 s, most of it pnpm checking the lockfile against `minimumReleaseAge` over the network. There is
no BuildKit cache mount for the pnpm store: Railway rejects a cache mount whose id does not start
with the Railway service's id, which a template cannot know.

The Node and pnpm versions in the Dockerfiles (`node:<version>` images, `pnpm@<version>`) are those
of `.node-version`, `.prototools` and `package.json#packageManager`: bump them together;
`pnpm check` (`tools/check-versions.mjs`) fails when any Dockerfile disagrees.

## The local stack: `docker-compose.stack.yml`

`web-e2e:stack-up` runs the images as production does: its own Postgres 18 (empty and in memory,
like a first deploy; not the dev database), the migrations as a one-off (`migrate`, the platform's
pre-deploy step), the API with no published port, and the web server on `127.0.0.1` and this
checkout's stack port (`pnpm ports`: "stack web"). The database has a port too, on `127.0.0.1`
and picked by Docker (`docker compose port db 5432`), only to seed it from here. It waits until
every service is healthy (about 5 to 10 s with the images cached). Each checkout gets its own
compose project, named `<compose project>-stack` (`stackProject` in
`node tools/dev-ports.mjs --json`; `STACK_PROJECT` overrides it), so worktrees never share one.

Both servers run with `NODE_ENV=production`, a read-only root file system and no Linux
capabilities. Their `INTERNAL_API_SECRET` is a fixed test value written in
`docker-compose.stack.yml`, so it guards nothing but this local stack, whose API no other machine
reaches. Run that file anywhere else (a server) only with `STACK_INTERNAL_API_SECRET` set to a
real secret; a platform running the images gets its own `INTERNAL_API_SECRET`. Writes are
rate-limited as in production (`STACK_WRITE_RATE_LIMIT=off` turns that off: the e2e specs write
far more); `REAL_IP_HEADER` is empty (no proxy in front). To look inside:

```bash
P=$(node tools/dev-ports.mjs --get stackProject)
docker compose -p "$P" -f docker-compose.stack.yml ps            # health of each service
docker compose -p "$P" -f docker-compose.stack.yml logs api web  # one request-log line per request
docker compose -p "$P" -f docker-compose.stack.yml exec db psql -U app -d app
```

Run `stack-down` when you are done (`tools/stack-down.mjs`): it removes the containers, the data,
the network and the stack's images, and the images earlier builds left untagged (Docker's classic
image store keeps the previous image when a rebuild moves its tag). Docker's build cache stays,
shared by all checkouts (`docs/local-resources.md`). Like `db-up down`, it leaves a project that is
not this checkout's own: one `STACK_PROJECT` or `COMPOSE_PROJECT_NAME` names may be another
checkout's, except in CI (`CI` set), where the project the workflow names is the run's own.
`pnpm prune:orphans` removes a deleted checkout's stack, its images included.

## The specs against the images: `web-e2e:e2e-stack`

`pnpm nx run web-e2e:e2e-stack` is the check for a change to a Dockerfile, `.dockerignore` or
`docker-compose.stack.yml`: every e2e spec against the images, in about 20 s with the images
cached. After building both images it runs `tools/e2e-stack.mjs`, which starts the stack with
`STACK_WRITE_RATE_LIMIT=off`; seeds its database from the repository (`db:db-seed`: dev-only code
stays out of the images, and the API's image migrated the empty database itself); runs the
migrations again, as every deploy does (they must exit 0 and keep the rows, which `seed.spec.ts`
then reads); runs every spec in BASE_URL mode (`docs/e2e.md`) with `E2E_SEEDED=1` and
`E2E_REQUIRE_STACK=1`; and runs `stack-down`, whatever failed before. Arguments after `--` go to
Playwright (`-- -g "board"`). Only the API's 401 spec skips: the API has no port here.
Interrupted (Ctrl-C, or Nx killing the task), it still leaves no stack behind: a watcher it starts
outside the task's process tree runs `stack-down` once the run is gone. The image builds and
`stack-up` refuse a stack project this checkout does not own (`tools/stack-guard.mjs`), so nothing
gets built or tagged under another checkout's stack names.

To keep the stack up between runs, do the same by hand:

```bash
STACK_WRITE_RATE_LIMIT=off pnpm nx run web-e2e:stack-up
P=$(node tools/dev-ports.mjs --get stackProject)
DATABASE_URL="postgresql://app:app@$(docker compose -p "$P" -f docker-compose.stack.yml port db 5432)/app" \
  pnpm nx run db:db-seed --excludeTaskDependencies
BASE_URL=$(node tools/dev-ports.mjs --get stack) E2E_SEEDED=1 pnpm nx run web-e2e:e2e-base-url
pnpm nx run web-e2e:stack-down
```

## CI: the `docker` job

Beside `pnpm check` (its own runner, `.github/workflows/ci.yml`), on every pull request and push to
main where `web-e2e` is affected (web, api or anything they use), or a file only this job reads
changed (`.dockerignore`, `docker-compose.stack.yml`, `.github/workflows/ci.yml`). Otherwise it
passes with a notice. It runs the steps of `e2e-stack`, as `acme-app-stack` with a random secret:

1. Builds the three images in one BuildKit run (`docker/bake-action` on the stack file, tagged as
   compose names them): their shared build stage (`pnpm fetch`, the offline install) runs once.
   Layers come from the GitHub Actions cache (`mode=max`, about 390 MB per image), which only a
   push to main writes: pull requests read main's, so their branches never evict it. It passes
   `RAILWAY_GIT_COMMIT_SHA` (the commit), the build argument Railway gives its builds.
2. Starts the stack, then checks the running images: the API logs `(production)`; PID 1 of api
   and web is not root; from inside the stack's network (the API has no port), the API answers
   401 without the secret and 200 with the web server's; both servers report the commit (the
   build argument above) as their version: the web server's `/api/health` and, through its BFF,
   the API's `apiVersion`.
3. Seeds the database, runs the migrations again, and runs every spec through BASE_URL mode with
   `E2E_SEEDED=1` and `E2E_REQUIRE_STACK=1` (3 workers): only the API's 401 spec skips.
4. Stops web, then api, with SIGTERM: each must exit 0 within 10 s. It runs after failed specs too.

On a failure the step "Stack logs" prints every container's log, and the `docker-test-output`
artifact holds the Playwright report and traces (`docs/e2e.md`). To reproduce a failure, run
`pnpm nx run web-e2e:e2e-stack`.

## What the images expect at runtime

| Variable                             | api                                                    | web                                            |
| ------------------------------------ | ------------------------------------------------------ | ---------------------------------------------- |
| `INTERNAL_API_SECRET` (32+ chars)    | required: the API refuses to start without it          | required: `/api/health` answers 503 without it |
| `DATABASE_URL`                       | required (`migrate.mjs` too)                           | -                                              |
| `API_HOST`, `API_PORT`               | -                                                      | required: the API's private host name and port |
| `PORT`                               | default 4000                                           | default 3000                                   |
| `LISTEN_HOST`                        | default `::` (IPv4 and IPv6)                           | (`NITRO_HOST`; default every interface)        |
| `READ_ONLY`, `DB_POOL_MAX`           | optional (`docs/api.md`)                               | -                                              |
| `REAL_IP_HEADER`, `WRITE_RATE_LIMIT` | -                                                      | optional (`docs/web.md`)                       |
| `EDGE_REQUEST_ID_HEADER`             | -                                                      | optional (`docs/production.md`)                |
| `NODE_OPTIONS=--enable-source-maps`  | optional: stack traces point at `src/` (about +20 MiB) | -                                              |
| `APP_VERSION`                        | baked in (build arg; `docs/production.md`), else `dev` | the same                                       |
| `LOG_FORMAT` (`json`, `text`)        | optional: default `json` in production                 | the same                                       |

- **Interfaces:** in a container both listen on every interface, as a platform's private network
  needs: the API in production mode (`::`), Nitro unless `NITRO_HOST` says otherwise (the image
  sets none). On this machine `web:serve` keeps the web server on `127.0.0.1` (`docs/web.md`).
- **Health:** the API's `/health` and the web server's `/api/health` (it checks the web server's
  own configuration, never the API). Each image has a Docker `HEALTHCHECK` on it, a `fetch` in
  `node -e` (slim images have no curl); Railway ignores it and checks the path itself.
- **Migrations:** `node dist/migrate.mjs` in the api image, before the new API starts; it applies
  only the migrations not yet applied, so it is safe to run on every deploy.
- **Users and signals:** both run as `node` (uid 1000) and cannot change their own files (owned by
  root). The `CMD` is exec form, so Node is PID 1 and gets SIGTERM itself: each server lets its
  requests in flight finish and then exits; the API closes its pool (about 0.1 s when idle), Nitro
  its server (about 1.1 s idle: srvx checks once a second; `docs/production.md`); `docker stop`
  never waits for the 10 s kill.

Measured on one machine (Docker 29, 16 cores): each image is about 83 MB compressed, nearly all of
it the Node base image (the API adds 6.5 MB unpacked, 4.2 MB of it source maps; the web server
2.4 MB); a container answers its health check 0.15 to 0.2 s after `docker run`; at idle the API
uses about 35 to 40 MiB and the web server 30 to 45 MiB.
