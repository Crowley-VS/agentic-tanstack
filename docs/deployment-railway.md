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
database no TCP proxy: keep it that way. Postgres 18 on Debian trixie, like the local
`postgres:18.6-trixie` (same glibc, same text sort order). Its `DATABASE_URL` has no `sslmode`:
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
The Hobby plan ($5/month) includes $5 of usage. Three small idle Node and Postgres containers
should stay within it (estimate, not measured on Railway: check the project's Usage page after a
day). The trial is a one-time $5 for 30 days; the Free plan's $1/month of credit is unlikely to
cover three services. Remove the project (Settings, Danger) when you are done with a scratch one.

## Set it up: infrastructure as code (experimental)

`.railway/railway.ts` declares the three services, their builds, watch paths, pre-deploy command,
health checks, draining time and variables, with Railway's TypeScript SDK (the `railway` package, a
beta pinned exactly in the catalog). The Railway CLI compares it with an environment and applies
the difference. You need:

- a Railway account with GitHub connected (the Railway GitHub app may read your repository);
- the Railway CLI 5.42.1 or newer: `brew install railway`, `npm i -g @railway/cli`, or
  `bash <(curl -fsSL railway.com/install.sh)` (`railway --version`).

From the repository root:

```bash
railway login                          # in your browser; an agent never logs in for you
railway init --name acme-app           # a new project (or `railway link` to an existing one)
```

Then, in the dashboard: **Project Settings → Shared Variables**, environment `production`, add
`INTERNAL_API_SECRET` with the output of
`node -p "require('node:crypto').randomBytes(32).toString('hex')"` (railway.ts only refers to
it; without it the api refuses to start and web's `/api/health` answers 503, so neither deploy
goes live). Then:

```bash
pnpm nx run railway-iac:test           # the file evaluates and holds its rules (offline)
railway config plan                    # read-only: 3 to add, the first time
railway config apply                   # asks before it changes anything
railway domain --service web --port 8080   # web's public domain (once; not part of the file)
```

The apply creates the services from your repository's `main`; each deploys once CI passes on that
commit (`checkSuites`, "Wait for CI"). `REPO` in `railway.ts` names the repository: check it is
yours. Bootstrap set it from `--repo` or your GitHub origin, else guessed `<scope>/<name>` (it
printed which). Wait for CI waits for every GitHub Actions run on the commit, and a failed one skips
the deploy: in the upstream template repository (`TEMPLATE_MAINTENANCE` set) that includes the
template smoke test, up to 40 minutes.

A push redeploys a service only when it changes one of its watch paths: its app, the workspace
packages its image bundles, and the files every install reads (`railway.ts` lists them; its test
derives the packages from the `package.json` files, so a new dependency fails it until it is
watched). A change to only `apps/api` redeploys only the api; docs, e2e specs and `.railway/`
redeploy nothing.

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
`.railway/railway.ts` to a reference project, runs **Project Settings → Generate Template from
Project**, sets `INTERNAL_API_SECRET` to `${{secret(64, "abcdef0123456789")}}` in the template
composer, and publishes it; the README then links `https://railway.com/deploy/<code>`. A button
deploy runs the upstream repository; to change the code, **Eject** the services (Settings, Source)
into your own GitHub copy. The template does not follow later changes to `.railway/railway.ts`:
re-generate it when they matter. Check a button deploy once after each re-generation: that the
composer kept the pre-deploy command, the watch paths and the draining time.

## Check a deploy

On a scratch project, once both services are live, with `<web>` the domain from `railway domain`.
They have not been run on Railway yet: they also confirm what this page takes from Railway's
documentation (that each field of `railway.ts` applies as typed, the build argument, the edge's
headers). Note the CLI version first (`railway --version`): `railway.test.ts` copies the
evaluation script of CLI 5.63.4.

1. **The file and the environment agree:** `railway config plan --detailed-exit-code` exits 0.
2. **The api has no public domain:** `railway domain list --service api --json` lists none.
3. **Migrations ran before the api started:** the api deployment's logs (dashboard, or
   `railway logs -s api -d -n 50`) show `migrations applied from /app/migrations` from the
   pre-deploy container, then `listening on … (production)`. The build log shows no error about
   `HEALTHCHECK --start-interval`.
4. **Web is up, reaches the api, and runs the commit:** `curl -fsS https://<web>/api/health`
   answers 200 with `version` the deployed commit's SHA, and
   `curl -sS https://<web>/api/graphql -H 'content-type: application/json' -d '{"query":"{ readOnly apiVersion }"}'`
   answers `readOnly: false` and the same SHA.
5. **The edge sets the client IP:** the same graphql curl with `-H 'X-Real-IP: 203.0.113.9'`:
   the api's log line for it has your address as `ip`, not 203.0.113.9.
6. **One request id across the logs:** the graphql answer's `x-request-id`, searched as
   `@requestId:<id>` in the project's logs, finds the web line, the api line and the HTTP log.
   The same curl with `-H 'x-railway-request-id: spoofed-1'` still answers another id (the edge
   sets its own).
7. **A change redeploys only what it touches**, on a scratch branch rather than `main`: set both
   services' source branch to it (Settings, Source), push a commit that changes only `apps/api`
   (a comment) and open a draft pull request, so CI runs on it: the api deploys once CI passes,
   web's deploy shows "skipped". A commit that changes only `docs/` deploys neither. Then close the
   pull request, delete the branch, and `railway config apply` (the file sets `main` back).
8. **Shutdown is graceful:** redeploy the api, then web (dashboard, Deployments, Redeploy). Each old
   deployment logs `SIGTERM: finishing in-flight requests, then exiting` as an info line of its
   own (web: then srvx's `Stopping server gracefully` and `Server closed successfully.`, on stderr,
   so shown as errors) and stops within a few seconds, never with the api's
   `requests still running after 8 s`.
9. **Optional, the e2e specs against the deploy:** set `WRITE_RATE_LIMIT=off` on web in the
   dashboard, then run `BASE_URL=https://<web> pnpm nx run web-e2e:e2e-base-url` (the specs that
   need the seed or the API's own address skip, `docs/e2e.md`; their notes stay in the database).
   `railway config plan` then lists that variable as one to delete, and `railway config apply`
   deletes it: an apply removes what the file leaves out.
10. **Costs:** the project's Usage page after about a day; then delete the scratch project.

## What an agent may do

Agents never log in, create tokens or read secrets. In `.claude/settings.json` every `railway`
command asks first: deploys (`railway up` even signs you in when you are not), `config apply`,
variable and domain changes, all of it. So do the Railway plugin's API script (`railway-api.sh`,
which calls Railway's API with your login) and its MCP server's tools. The plugin's own hook
approves its commands, but a hook cannot skip an ask rule; `tools/test/railway-permissions.test.mjs`
keeps the rules. An agent may edit `.railway/railway.ts` and run
`pnpm nx run railway-iac:test` freely; it shows you `railway config plan` and applies only when
you approve. Variable values are redacted in plans; `--show-values`, `--decrypt-variables` and
`railway variable list --kv` or `--json` print secrets: never paste their output anywhere.
