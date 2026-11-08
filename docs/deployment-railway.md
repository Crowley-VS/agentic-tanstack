# Deploying to Railway

Details behind `.railway` in the repo map of `AGENTS.md`: what runs on Railway, the two ways to set
it up (`.railway/railway.ts` or the dashboard), what it costs, how to check a deploy, and what an
agent may do. The images are the Dockerfiles in `apps/api` and `apps/web` (`docs/deployment.md`),
the same on every platform; what they do at runtime (logs, versions, request ids, shutdown, client
IP) is in `docs/production.md`, Railway's side included: searching its logs, its SIGTERM and
draining, the client IP its edge sets.

## What runs

One Railway project, three services per environment:

| Service    | Built from                                                     | Reachable at                                    | Health check  |
| ---------- | -------------------------------------------------------------- | ----------------------------------------------- | ------------- |
| `Postgres` | Railway's image `ghcr.io/railwayapp-templates/postgres-ssl:18` | `postgres.railway.internal:5432` (private only) | Railway's own |
| `api`      | `apps/api/Dockerfile`; `node dist/migrate.mjs` before deploys  | `api.railway.internal:8080` (private only)      | `/health`     |
| `web`      | `apps/web/Dockerfile`                                          | its `*.up.railway.app` domain (public)          | `/api/health` |

The browser only ever talks to web; web's BFF and SSR reach the api over Railway's private network
(WireGuard, `http://`), sending `INTERNAL_API_SECRET`. The api has no public domain, and the
database no TCP proxy: keep it that way. Postgres 18 on Debian trixie, like the local image
(`docker-compose.yml`: same glibc, same text sort order). Its `DATABASE_URL` has no `sslmode`:
the connection stays on the private network.

What the servers get from Railway with no setting of theirs (`docs/production.md`):

- **Client IP:** Railway's edge sets `X-Real-IP` to the client's address, the BFF's default
  `REAL_IP_HEADER`: the write rate limit and the API log see real client IPs.
- **Request ids:** the edge names each request in `X-Railway-Request-Id`, the web server's default
  `EDGE_REQUEST_ID_HEADER`. The web line, the API lines and Railway's HTTP log of one request carry
  that id: `@requestId:<id>` in the project's logs finds all of them.
- **Version:** Railway passes `RAILWAY_GIT_COMMIT_SHA` to the Dockerfile builds, which bake it in
  as `APP_VERSION`: `/api/health` answers `{"status":"ok","version":"<commit>"}`, and every JSON
  log line carries it. `dev` means the build argument did not arrive.
- **Shutdown:** Railway sends SIGTERM to the old deployment once the new one is live, then SIGKILL
  after the draining time: 0 s unless set. `.railway/railway.ts` sets 10 s for both services
  (`deploy.drainingSeconds`), above the API's own 8 s limit and srvx's 5 s (web), so a deploy cuts
  no request either server would still finish.

## What it costs

Builds are free; running containers are billed by the minute: RAM $10/GB-month, CPU
$20/vCPU-month, egress $0.05/GB, volumes $0.15/GB-month (Railway's pricing page, October 2026).
The Hobby plan ($5/month) includes $5 of usage. Measured on a scratch project over a week in
October 2026 (idle, plus a dozen redeploys): $0.36 in all, about $0.05 a day or $1.60 per 30 days,
a third of Hobby's included usage. Nearly all of it is memory (about 55 MB per Node service, 40 MB
for Postgres); CPU, egress and the volume cost cents. `railway usage projects --project <name>`
shows the figures (the dashboard's Usage page too). The trial is a one-time $5 for 30 days; the
Free plan's $1/month of credit does not cover three services. Remove the project (Settings,
Danger) when you are done with a scratch one.

## Set it up: infrastructure as code (experimental)

`.railway/railway.ts` declares the three services, their builds, watch paths, pre-deploy command,
health checks, draining time and variables, with Railway's TypeScript SDK (the `railway` package, a
beta pinned exactly in the catalog). The Railway CLI compares it with an environment and applies
the difference. You need:

- a Railway account with GitHub connected (the Railway GitHub app may read your repository);
- the Railway CLI 5.42.1 or newer (checked with 5.64.2): `brew install railway`,
  `npm i -g @railway/cli`, or `bash <(curl -fsSL railway.com/install.sh)` (`railway --version`).

Create the project from the CLI, not with the dashboard's **Deploy from GitHub repo**: that one
builds a single service named after the repository with Railpack, which fails on this monorepo (if
you made it, the next plan lists it to destroy, and the apply removes it).

From the repository root:

```bash
railway login                          # in your browser; an agent never logs in for you
railway init --name acme-app           # a new project (or `railway link` to an existing one)
```

Then, in the dashboard: **Project Settings → Shared Variables**, environment `production`, add
`INTERNAL_API_SECRET` with the output of
`node -p "require('node:crypto').randomBytes(32).toString('hex')"`, then click **Deploy** on the
canvas's bar of staged changes. Only the dashboard sets shared variables (`railway variable set`
sets a service's own), and railway.ts only refers to it. Until the change is deployed,
`${{shared.INTERNAL_API_SECRET}}` resolves to an empty value without a warning, `railway config
plan` does not show it either, and the api fails its deploy after about 5 minutes of restarts
(`INTERNAL_API_SECRET is required in production`); web's deploy fails after it. Once deployed, the
name appears under `sharedVariables` in `railway environment config --json` (which also holds the
values: look, never paste it). Then:

```bash
pnpm nx run railway-iac:test           # the file evaluates and holds its rules (offline)
railway config plan                    # read-only: 3 to add, the first time
railway config apply                   # asks before it changes anything
railway config plan                    # again: it lists source.checkSuites (null → true)
railway config apply                   # again: turns Wait for CI on (see below)
railway domain --service web --port 8080   # web's public domain (once; not part of the file)
```

The apply that creates the services leaves their **Wait for CI** off (`source.checkSuites`
null): the second plan lists `source.checkSuites (null → true)` on both, and the second
`railway config apply` turns it on. Until then a push deploys before CI has run. Plan and apply
end with a hint to run `railway setup agent`: skip it, it installs Railway's skills and MCP server
into your agent config, which this repository already sets up (`docs/agents.md`). To apply exactly
what you reviewed, pin the plan: `railway config plan --out .agents/ignore/railway-plan.json`
(a gitignored folder, so neither the format check nor a commit picks the file up), then
`railway config apply --plan .agents/ignore/railway-plan.json --yes` (and `--confirm-destructive`
when the plan deletes something), which also works where no one answers a prompt.

The apply creates the services from your repository's `main`; once Wait for CI is on (the second
apply, above), each deploys a commit only after CI passes on it (`checkSuites`). `REPO` in `railway.ts` names the repository: check it is
yours. Bootstrap set it from `--repo` or your GitHub origin, else guessed `<scope>/<name>` (it
printed which). Wait for CI waits for every GitHub Actions run on the commit, and only for those:
check suites of other GitHub apps on the account (another host's, say) may stay queued and do not
hold a deploy. A failed run skips the deploy (`SKIPPED` in `railway deployment list -s <service>`;
`railway status --json` shows it as failed); a passing one releases a waiting deploy within
seconds. `railway redeploy -s <service> --from-source` deploys the branch's latest commit;
`railway redeploy -s <service> --yes` redeploys the deployment that runs.

<!-- template-only:start -->

In the upstream template repository (`TEMPLATE_MAINTENANCE` set), the runs Wait for CI waits for
include the template smoke test, up to 40 minutes, and release-please (`docs/maintaining.md`).

<!-- template-only:end -->

A push redeploys a service only when it changes one of its watch paths: its app, the workspace
packages its image bundles, and the files every install reads (`railway.ts` lists them; its test
derives the packages from the `package.json` files, so a new dependency fails it until it is
watched). A change to only `apps/api` or `packages/db` redeploys only the api; docs, `tools/`, e2e
specs and `.railway/` redeploy nothing (the skip shows at once, before CI ends); a change to the root
`package.json` or the lockfile redeploys both. So the two services may run different commits:
`railway variable set` redeploys the commit a service runs, while a `railway config apply` that
changes a variable builds the branch's latest commit, even one its watch paths skipped.

**Changing it:** edit `.railway/railway.ts`, run `pnpm nx run railway-iac:test`, then
`railway config plan` and `railway config apply`. An apply makes the environment match the file:
**a service or variable the file leaves out is deleted** (the plan marks it destructive; volumes,
the database's data included, are never deleted by an apply). So a variable set in the dashboard
(`READ_ONLY=true` in an incident, say) goes away at the next apply unless you add it to the file
first; so does tracing switched on in the dashboard (`tracing: { enabled: true }` in the file keeps
it). Web's generated domain is never in the file, and an apply leaves it alone.
`railway config plan --detailed-exit-code` exits 2 while the environment differs from the file.

Railway's `railwayapp/config` GitHub Action can plan on pull requests and apply on merge, with a
project token in the `RAILWAY_TOKEN` secret. It is not set up here: forks have no token, and an
apply deletes what the file omits.

## Set it up: the dashboard

The same project by hand, if you would rather not use the SDK (or it breaks):

1. **New Project → Database → PostgreSQL.** Check its image is `postgres-ssl:18` (Settings, Source).
2. **Project Settings → Shared Variables:** `INTERNAL_API_SECRET`, as above.
3. **New → GitHub Repo →** your repository; rename the service `api`. In its Settings:
   Source: branch `main`, **Wait for CI** on; Build: builder Dockerfile, Dockerfile path
   `apps/api/Dockerfile`, Watch Paths (one per line) the api's `watchPatterns` in
   `.railway/railway.ts` (its test keeps them in step with the packages the image bundles); Deploy: Pre-deploy Command `node dist/migrate.mjs`,
   Healthcheck Path `/health`; Networking: no public domain. Variables (Raw Editor):

   ```bash
   PORT=8080
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   INTERNAL_API_SECRET=${{shared.INTERNAL_API_SECRET}}
   RAILWAY_DEPLOYMENT_DRAINING_SECONDS=10
   ```

4. **New → GitHub Repo →** the same repository again; rename it `web`. Settings as for the api,
   with Dockerfile path `apps/web/Dockerfile`, Watch Paths web's `watchPatterns` in
   `.railway/railway.ts`, no pre-deploy command,
   Healthcheck Path `/api/health`, and **Networking → Generate Domain** on port 8080. Variables:

   ```bash
   PORT=8080
   API_HOST=${{api.RAILWAY_PRIVATE_DOMAIN}}
   API_PORT=${{api.PORT}}
   INTERNAL_API_SECRET=${{shared.INTERNAL_API_SECRET}}
   RAILWAY_DEPLOYMENT_DRAINING_SECONDS=10
   ```

To switch to the file later, `railway config plan` shows what differs; `railway config pull`
writes the project's current state as a starting file.

Do not add `railway.json` or `railway.toml`: Railway's Config as Code is deprecated, new services
cannot use it, and existing files stop being read on 2026-12-01.

## The "Deploy on Railway" button

A Railway template lives on Railway, not in this repository: the maintainer applies
`.railway/railway.ts` to a reference project and runs **Project Settings → Generate Template from
Project**. Generation keeps the references (`${{Postgres.DATABASE_URL}}`,
`${{api.RAILWAY_PRIVATE_DOMAIN}}`, …), the pre-deploy command, the health checks and web's public
port, but not every value, and no build settings. Fix these in the template composer before
sharing it, in each service's Variables → Raw Editor:

- **No build settings**: the template has no builder, Dockerfile path or watch paths. Without a
  path, Railway builds the repository's root, which has no Dockerfile: set `RAILWAY_DOCKERFILE_PATH`
  to `apps/api/Dockerfile` on api and `apps/web/Dockerfile` on web, and Railway builds that
  Dockerfile. The watch paths have no variable: a button deploy runs without them.
- **Plain values come out empty**, for whoever deploys to fill in: set `PORT` to `8080` on api and
  web, and Postgres's own values to Railway's (those of the reference project's Postgres):
  `PGDATA=/var/lib/postgresql/data/pgdata`, `PGPORT=5432`, `POSTGRES_DB=railway`,
  `POSTGRES_USER=postgres`, `SSL_CERT_DAYS=820`, `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=60`.
- **A template has no shared variables**, so `${{shared.INTERNAL_API_SECRET}}` resolves to
  nothing: set api's `INTERNAL_API_SECRET` to `${{secret(64, "abcdef0123456789")}}` (a new secret
  for each deploy) and web's to `${{api.INTERNAL_API_SECRET}}`.
- **Add `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=10` to api and web**, as the dashboard setup does.
  The composer does not show the apps' draining time (`deploy.drainingSeconds`, 10 s); a variable
  is the setting it shows and keeps.

The template takes the project's name: set its name and description under Template Settings (the
deploy page shows them). The composer **stages** edits: until you apply them (the "Apply N changes"
bar above the canvas, which a window narrower than about 1,000 px hides), the deploy link (Share,
below) deploys the template as generated. Open the link afterwards: each service should say "Ready
to be deployed", with no value left to fill in.

The composer's **Share** gives the link, `https://railway.com/deploy/<code>`, which works without
publishing the template to Railway's marketplace; link it from the repository's README with
`[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/<code>)`. The
template does not follow later changes to `.railway/railway.ts`: re-generate it when they matter
(if Share then gives a new code, update the README's link), and check a button deploy once after
each re-generation:

- each build log reads `load build definition from apps/api/Dockerfile` (web's,
  `apps/web/Dockerfile`);
- the migration ran before the api started, and both health checks pass (Check a deploy, below,
  items 3 and 4);
- api and web list `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=10` under Variables;
- the board loads.

A button deploy runs the code of the repository the template was generated from. To change it,
**Eject** the services (Settings, Source) into your own GitHub copy. That copy is the template as
is: bootstrap it (README, Quickstart) so `.railway/railway.ts` names your repository, and add the
shared variable `INTERNAL_API_SECRET` (Set it up, above) before any `railway config apply`, which
points both services at it. That first apply also sets the builds, watch paths and draining time
from the file, and deletes the template's `RAILWAY_DOCKERFILE_PATH` and
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS` variables, which the file does not list: its plan shows them as
destructive.

## Check a deploy

On a scratch project, once both services are live, with `<web>` the domain from `railway domain`.
All ten passed on Railway in October 2026 (CLI 5.64.2, a scratch project in us-west2), which also
confirmed what this page takes from Railway's documentation: each field of `railway.ts` applies as
typed (except `checkSuites` on the apply that creates the services: Set it up, above), the build
argument arrives, the edge sets its headers. Note the CLI version first
(`railway --version`): `railway.test.ts` copies the evaluation script of CLI 5.63.4, unchanged
through 5.64.2. Every `railway` command asks first (What an agent may do, below).

1. **The file and the environment agree:** `railway config plan --detailed-exit-code` exits 0
   (after the first apply only once Wait for CI is on: Set it up, above).
2. **The api has no public domain:** `railway domain list --service api --json` lists none.
3. **Migrations ran before the api started:** the api deployment's logs (dashboard, or
   `railway logs -s api -d -n 50`) show `migrations applied from /app/migrations` from the
   pre-deploy container, then `listening on http://localhost:8080/graphql (production)` (it binds
   every address), each line with the commit as `version`. The build log shows no error about
   `HEALTHCHECK --start-interval`, and the deploy log `Healthcheck succeeded`. A redeploy runs the
   pre-deploy migration again (it finds nothing to do).
4. **Web is up, reaches the api, and runs the commit:** `curl -fsS https://<web>/api/health`
   answers 200 with `version` the deployed commit's SHA, and
   `curl -sS https://<web>/api/graphql -H 'content-type: application/json' -d '{"query":"{ readOnly apiVersion }"}'`
   answers `readOnly: false` and the same SHA, once both services have deployed that commit (a
   commit only one service watches redeploys only that one).
5. **The edge sets the client IP:** the same graphql curl with `-H 'X-Real-IP: 203.0.113.9'`:
   the api's log line for it has your address as `ip`, not 203.0.113.9.
6. **One request id across the logs:** the graphql answer's `x-request-id` (the edge's
   `x-railway-request-id`), searched as `@requestId:<id>`, finds the web line, the api line and the
   HTTP log: `railway logs -s <service> -d --filter '@requestId:<id>' -n 20 --json` for each
   service, `railway logs -s web --http --filter '@requestId:<id>' --json` for the HTTP log (with
   `srcIp`, `httpStatus`, `path`, `totalDuration`). The same curl with
   `-H 'x-railway-request-id: spoofed-1'` still answers another id (the edge sets its own).
7. **A change redeploys only what it touches**, seen on the next merges to `main`
   (`railway deployment list -s <service>`): one that changes only `packages/db` or `apps/api`
   deploys the api once CI passes and shows web's deploy as `SKIPPED`; one that changes only
   `docs/` or `tools/` deploys neither; one that changes the root `package.json` deploys both. A
   watch-path skip shows at once, before the commit's CI ends; a skip for failed CI shows only after
   a red run, so check the commit's CI is green before reading a `SKIPPED` as a watch-path one.
8. **Shutdown is graceful:** redeploy the api, then web (`railway redeploy -s <service> --yes`,
   or the dashboard's Deployments, Redeploy). After Railway's `sending signal SIGTERM to
container`, each old deployment logs `SIGTERM: finishing in-flight requests, then exiting` as
   an info line of its own (the api's with `inFlight`; web's after an empty line, then one
   error-level line holding srvx's `Stopping server gracefully` and `Server closed successfully.`,
   which it writes to stderr). Each exits on its own: its last line (web's `Server closed
successfully.`) comes within a second or two of its SIGTERM line, well inside the 10 s draining
   time, never with the api's `requests still running after 8 s`; Railway then removes the old
   container (about 15 s after SIGTERM in October 2026). `railway logs <deployment id>` needs
   `-s <service>` too.
9. **Optional, the e2e specs against the deploy:** `railway variable set WRITE_RATE_LIMIT=off -s web`
   (it redeploys web, once CI passes), then run
   `BASE_URL=https://<web> pnpm nx run web-e2e:e2e-base-url`: every spec passes except those that
   need the seed (seed.spec, the board's seed tests) or the API's own address (the harness's
   401 check), which skip (`docs/e2e.md`; 11 passed and 5 skipped in October 2026; their notes
   stay in the database). `railway config plan --detailed-exit-code` then lists that variable as
   one to delete and exits 2, and `railway config apply` deletes it: an apply removes what the file
   leaves out.
10. **Costs:** `railway usage projects --project <name>` after about a day (What it costs, above);
    then delete the scratch project, or keep it as your reference project.

## What an agent may do

Agents never log in, create tokens or read secrets. In `.claude/settings.json` every `railway`
command asks first: deploys (`railway up` even signs you in when you are not), `config apply`,
variable and domain changes, all of it. So do the Railway plugin's API script (`railway-api.sh`,
which calls Railway's API with your login) and its MCP server's tools. The plugin's own hook
approves its commands, but a hook cannot skip an ask rule; `tools/test/permissions.test.mjs`
keeps the rules. An agent may edit `.railway/railway.ts` and run
`pnpm nx run railway-iac:test` freely; it shows you `railway config plan` and applies only when
you approve. Variable values are redacted in plans; `--show-values`, `--decrypt-variables`,
`railway variable list --kv` or `--json` and `railway environment config --json` print secrets:
never paste their output anywhere.
