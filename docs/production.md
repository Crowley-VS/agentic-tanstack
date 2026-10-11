# Running in production (`apps/api`, `apps/web`)

What the two servers do at runtime once deployed: what they log, which version they report, the
request id that ties their lines together, how they shut down, and which client IP they believe.
Building the images and running them together: `docs/deployment.md`.

## Logs: one JSON line per event

Both servers log through `@acme/logger` (`packages/logger`, no dependencies): one JSON object per
line on stdout in production (`NODE_ENV=production`, which the images set, or any production build
of the web app), a text line elsewhere. `LOG_FORMAT=json` or `text` overrides that.

```text
{"time":"2026-10-08T13:26:54.785Z","level":"info","app":"web","version":"9f2c1ab","message":"200 GET / 57ms","requestId":"edge-ssr-1","method":"GET","path":"/","status":200,"ms":57,"ip":"203.0.113.50"}
```

| Field                                            | On                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| `time`, `level`, `app` (`web`, `api`), `message` | every line (`level`: `info`, `warn` or `error`)                  |
| `version`                                        | every line: `APP_VERSION` (below), `dev` when unset              |
| `requestId`                                      | request lines, and the error lines of a request (below)          |
| `method`, `path`, `status`, `ms`, `ip`           | request lines; `ms` runs until the response starts (its headers) |
| `err`                                            | error lines: the error's name, message, stack and causes         |

An `err` follows what the error wraps, three deep: its `cause`, or for a GraphQL error the error
its resolver threw (graphql-js's `originalError`). So a failed query's line reads GraphQLError,
then DrizzleQueryError, then the driver's error that says why (`connect ECONNREFUSED …`, a
Postgres error); a stack the wrapper shares with what it wraps is written once.

What writes a line:

- **Every request** each server answers: the API's (`plugins/request-log.ts`), and the web
  server's for every request Start handles (`src/start.ts`: pages, `/api/graphql`, server
  functions). Health checks are left out on both, and so are the static assets Nitro serves
  itself and, in development, GraphiQL's page. A 5xx answer is level `error`; a web request whose
  connection closed before the answer (the browser left, or a shutdown cut it off) logs status 499. A request whose `Host` is no valid URL authority gets a 400 from the API and its line from
  `src/main.ts`, before Yoga. The API's `ip` and `requestId` are those the web server sends
  (`x-client-ip`, `x-request-id`), believed only with the internal secret; else the socket's
  address and no id.
- **Errors**: an unexpected API error (masked as `Unexpected error.` for the client) with its stack
  and request id; the BFF's 502 and 504; a page that failed to render (the error page), with the
  request id; an invalid web environment (from `/api/health`).
- Start-up (the API's `listening on http://… (production)`), migrations (`dist/migrate.mjs`), and
  SIGTERM.

**On Railway** (its logs guide): a JSON line is parsed when it is one line; `message` is what the
log view shows, `level` colors it, and every other field becomes a filter: `@requestId:<id>`,
`@level:error`, `@status:500`, `@path:/api/graphql`. The field is `app`, not `service`: Railway's
own `@service:<id>` filter names services by their id. Two limits: a line on stderr is shown as an
error whatever it says (hence JSON lines all go to stdout), and a replica may write at most 500
lines a second (one line per request: about 500 requests a second per replica before lines are
dropped; an SSR page writes a web line and one API line per query it runs).

Text that still reaches the logs, as plain lines: Node's own output (an invalid API environment at
start, where the API refuses to start listing every problem, and a crash), srvx's `Listening on`
at start and its shutdown countdown on stderr (`Stopping server gracefully (5s)...`, then
`Server closed successfully.`: error lines on Railway; Shutdown, below), and h3's multi-line dump
of an error a server route throws (only with an invalid web environment, whose failing health check
keeps such a deploy from going live).

No pino: these servers need one line per event, and pino would add 11 packages and 126 kB to each
server bundle (measured with tsdown), plus pino-pretty for development, whose worker-thread
transport does not survive bundling.

## The version: `APP_VERSION`

The images bake it in at build time; both servers only read `APP_VERSION`: the API's
`Query.apiVersion` (which the web server's BFF serves to anyone), the web's `/api/health`
(`{"status":"ok","version":"9f2c1ab"}`), and every JSON log line. After the `COPY` lines of each
Dockerfile's runtime stage (so a new version rebuilds only the layers from there on):

```dockerfile
# Railway passes its variables to a Dockerfile build as build args when they are declared: a
# deploy from GitHub has the commit's SHA. Elsewhere: --build-arg APP_VERSION=<version>.
ARG RAILWAY_GIT_COMMIT_SHA
ARG APP_VERSION=${RAILWAY_GIT_COMMIT_SHA:-dev}
ENV APP_VERSION=${APP_VERSION}
```

Other builds pass it: `docker build --build-arg APP_VERSION=$(git rev-parse --short HEAD) -f
apps/api/Dockerfile .`. CI's docker job passes `RAILWAY_GIT_COMMIT_SHA` (the commit), as Railway
does, and checks that `/api/health` answers it as `version` and the BFF as `apiVersion`. It is
public: a commit SHA, never a secret.

## Request ids: one id per browser request, in both servers' lines

1. The web server takes the edge's id for the request (`EDGE_REQUEST_ID_HEADER`, default
   `x-railway-request-id`: Railway's edge sets it on every request, and its HTTP logs show it as
   `requestId`), else an `x-request-id` the client or another proxy sent, else a new UUID. Only a
   short, plain value is taken (`[\w.:-]{1,128}`): it goes into log lines.
2. It is worked out once per request and kept on the `Request` object
   (`src/server/request-context.server.ts`): the request middleware's line (`src/start.ts`), the
   BFF, and every API call a page makes while it renders (`execute()` reads the page request with
   Start's `getRequest()`) use the same id and client IP. They reach the API as `x-request-id` and
   `x-client-ip`, with the internal secret.
3. The API believes both only with the secret; its request line and its error lines carry them.
4. The web server answers with `x-request-id` (pages, the BFF's relayed answers and its own 429,
   502 and 504), so a visitor's report (the browser's network tab) leads to the lines.

On Railway, `@requestId:<id>` finds the request in the web service's logs, the API's, and the
edge's HTTP logs.

## Shutdown: SIGTERM finishes what is in flight

Railway sends SIGTERM to the old deployment once the new one is live, and SIGKILL after
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, **0 by default**: without it set (10 s covers both servers),
no request in flight survives a deploy. `.railway/railway.ts` sets 10 s (`deploy.drainingSeconds`;
`docs/deployment-railway.md`). Both images run `node` as PID 1, so the servers' own
handlers are all there is.

|                        | API (`src/main.ts`)                                   | web (Nitro's server, srvx)                                      |
| ---------------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| On SIGTERM             | stops listening; in-flight requests finish; pool ends | stops listening; in-flight requests finish                      |
| Keep-alive connections | every answer from then on says `connection: close`    | the same, from the request middleware (`request-log.server.ts`) |
| Gives up               | after 8 s: exit 1, with an error line                 | after `SERVER_SHUTDOWN_TIMEOUT` (5 s): cuts connections, exit 0 |

Without `connection: close`, a client's keep-alive connection (the web server's to the API, the
platform proxy's to the web server) stays open after its answer, and each shutdown waited for the
timeout. Measured on the production builds with a keep-alive client and a request in flight for
3 s (web: `docker compose stop web` on the image, "before" on its bundle; the API: its bundle,
with a query held by a table lock):

| Case                   | Before                                           | After                                     |
| ---------------------- | ------------------------------------------------ | ----------------------------------------- |
| web, request in flight | exits at the 5 s timeout                         | exits as it finishes: 3.2 s, exit code 0  |
| API, request in flight | forced exit at 8 s, exit code 1                  | exits as it finishes: about 2.8 s, exit 0 |
| idle                   | web 1.1 s (srvx checks once a second), API 0.1 s | the same                                  |

srvx handles SIGTERM only when neither `CI` nor `TEST` is set in the runtime environment. With
either set, the web server ignores SIGTERM as PID 1 and is killed (`docker stop -t 3` took 3.1 s,
exit 137): the runtime stage of the image must not set them (a build stage's `ENV CI=true` does
not carry over; `tools/test/docker-images.test.mjs` checks both). Outside a container Node's
default ends the process at once; the request middleware adds no SIGTERM listener of its own
then, since one would cancel that default.

The web server's shutdown in its log: its JSON line `SIGTERM: finishing in-flight requests, then
exiting` first, then srvx's countdown on stderr, one line srvx rewrites every second and ends only
once the server has closed (`\rStopping server gracefully (5s)...`, then
`\x1b[2K\rServer closed successfully.`). Railway reads stdout and stderr as one stream: a line
written while srvx's is open joins it, and Railway keeps the two as one error-level text line, the
JSON in it lost (so went the SIGTERM line and the in-flight requests' lines, before). So the
request middleware listens for SIGTERM ahead of srvx, and from then on each line starts with a
newline (`src/server/log.server.ts`): at worst an empty line between two lines.
`src/built-server.test.ts` runs the production build with both streams on one file and checks
every line.

## The client's IP

The web server counts writes per client IP and passes the IP to the API's log. It takes it from
the header named by `REAL_IP_HEADER` (default `x-real-ip`) when that holds an IP, else the
socket's address; never from `X-Forwarded-For`, whose first entries the client writes. A value
that is no header name (`X-Real-IP:`) is refused at start: `/api/health` answers 503.

- **Railway**: its edge sets `X-Real-IP` to the client's address on every request and overwrites
  one a client sends (the specs-and-limits page; the overwrite was fixed in August 2024 after a
  report that clients could set it). Railway publishes no address ranges for its proxies, so the
  header is the whole contract, and it has regressed before (in 2026 it carried a CDN edge's
  address instead of the client's for a while; fixed). Keep the default.
- **A proxy in front of Railway** (Cloudflare's proxied DNS, a load balancer): `X-Real-IP` then
  holds that proxy's address. Name the header that proxy sets (Cloudflare: `cf-connecting-ip`),
  and remove the service's `*.up.railway.app` domain: through it a client reaches Railway's edge
  directly and can send that header itself.
- **Another host**: name a header the proxy in front always overwrites: Fly.io's `fly-client-ip`,
  Cloudflare's `cf-connecting-ip`, nginx with `proxy_set_header X-Real-IP $remote_addr;` (the
  default name). With no proxy in front, set it empty, or any client can claim any address (and
  dodge the write limit).
- `EDGE_REQUEST_ID_HEADER` follows the same rules: the header the proxy in front sets (empty when
  none; an `x-request-id` is still taken).
