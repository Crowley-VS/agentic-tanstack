# Running in production (`apps/api`)

What the API does at runtime once deployed: what it logs, which version it reports, and how it
shuts down. Building the images and running them together: `docs/deployment.md`.

## Logs: one JSON line per event

The API logs through `@acme/logger` (`packages/logger`, no dependencies): one JSON object per line
on stdout in production (`NODE_ENV=production`, which the image sets), a text line elsewhere.
`LOG_FORMAT=json` or `text` overrides that.

```text
{"time":"2026-10-08T13:26:54.785Z","level":"info","app":"api","version":"9f2c1ab","message":"200 POST /graphql 12ms","requestId":"0b7e7f0e-6d0e-4c43-9a51-3c1d0c5a2f43","method":"POST","path":"/graphql","status":200,"ms":12,"ip":"203.0.113.50"}
```

| Field                                     | On                                                               |
| ----------------------------------------- | ---------------------------------------------------------------- |
| `time`, `level`, `app` (`api`), `message` | every line (`level`: `info`, `warn` or `error`)                  |
| `version`                                 | every line: `APP_VERSION` (below), `dev` when unset              |
| `requestId`                               | request lines, and the error lines of a request (below)          |
| `method`, `path`, `status`, `ms`, `ip`    | request lines; `ms` runs until the response starts (its headers) |
| `err`                                     | error lines: the error's name, message, stack and causes         |

What writes a line:

- **Every request** the API answers (`plugins/request-log.ts`), but its health checks (and, in
  development, GraphiQL's page). A 5xx answer is level `error`. A request whose `Host` is no valid
  URL authority gets a 400 and its line from `src/main.ts`, before Yoga. The `ip` and `requestId`
  are those the web server sends (`x-client-ip`, `x-request-id`), believed only with the internal
  secret; else the socket's address and no id.
- **Errors**: an unexpected error (masked as `Unexpected error.` for the client), with its stack
  and the request's id.
- Start-up (`listening on http://… (production)`), migrations (`dist/migrate.mjs`), and SIGTERM.

**On Railway** (its logs guide): a JSON line is parsed when it is one line; `message` is what the
log view shows, `level` colors it, and every other field becomes a filter: `@requestId:<id>`,
`@level:error`, `@status:500`, `@path:/graphql`. The field is `app`, not `service`: Railway's own
`@service:<id>` filter names services by their id. Two limits: a line on stderr is shown as an
error whatever it says (hence JSON lines all go to stdout), and a replica may write at most 500
lines a second (one line per request: about 500 requests a second per replica before lines are
dropped). Node's own output still reaches the logs as plain text: an invalid environment at start
(the API refuses to start, listing every problem) and a crash.

No pino: the API needs one line per event, and pino would add 11 packages and 126 kB to the server
bundle (measured with tsdown), plus pino-pretty for development, whose worker-thread transport does
not survive bundling.

## The version: `APP_VERSION`

The api image bakes it in at build time; the API only reads `APP_VERSION`: `Query.apiVersion`
(which the web server's BFF serves to anyone) and every JSON log line. After the `COPY` lines of
the Dockerfile's runtime stage (so a new version rebuilds only the layers from there on):

```dockerfile
# Railway passes its variables to a Dockerfile build as build args when they are declared: a
# deploy from GitHub has the commit's SHA. Elsewhere: --build-arg APP_VERSION=<version>.
ARG RAILWAY_GIT_COMMIT_SHA
ARG APP_VERSION=${RAILWAY_GIT_COMMIT_SHA:-dev}
ENV APP_VERSION=${APP_VERSION}
```

Other builds pass it: `docker build --build-arg APP_VERSION=$(git rev-parse --short HEAD) -f
apps/api/Dockerfile .`. CI's docker job passes `RAILWAY_GIT_COMMIT_SHA` (the commit), as Railway
does, and checks that the BFF answers it as `apiVersion`. It is public: a commit SHA, never a
secret.

## Shutdown: SIGTERM finishes what is in flight

Railway sends SIGTERM to the old deployment once the new one is live, and SIGKILL after
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, **0 by default**: without it set (10 s is enough), no
request in flight survives a deploy. The image runs `node` as PID 1, so the API's own handlers
(`src/main.ts`) are all there is:

- it stops listening, lets the requests in flight finish, then closes the database pool;
- every answer from then on says `connection: close`: without it a client's keep-alive connection
  (the web server's) stays open after its answer, and the shutdown waited for the force exit;
- it gives up after 8 s (under Docker's 10 s and a 10 s drain): exit 1, with an error line.

Measured on the production bundle with a request in flight (a query held about 3.5 s by a table
lock): before, the forced exit at 8 s with exit code 1; now it exits as the request finishes,
about 2.8 s after SIGTERM, with exit code 0. Idle, it exits in about 0.1 s.
