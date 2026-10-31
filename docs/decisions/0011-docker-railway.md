# 0011 — Docker images, deployed to Railway (infrastructure as code: experimental)

- **Status:** accepted (2026-09-29; spike S3 passed)
- **Applies to:** `apps/api/Dockerfile`, `apps/web/Dockerfile`, `.dockerignore`,
  `docker-compose.stack.yml`, `.railway/railway.ts`

## Context

The API must not be reachable from the internet: only the web server calls it. The deploy should be
portable (no code tied to one platform), cheap for a small project, with managed Postgres 18, and
reviewable as a change in the repository. What runs in production should also be what the e2e
specs tested.

## Decision

- **Two small images** from the repository root, on `node:24.21.0-trixie-slim`: the API's tsdown
  bundle plus its migrations, and the web app's Nitro `.output`. No `node_modules`, package manager
  or build tools in the runtime stage; non-root (`node`); Node is PID 1 and shuts down on SIGTERM
  after its in-flight requests ([deployment.md](../deployment.md), [production.md](../production.md)).
- **Checked like production**: `pnpm nx run web-e2e:e2e-stack` and CI's `docker` job run the
  images together (Postgres 18, the migration as a pre-deploy step, a private API, the web server)
  and run every e2e spec against them.
- **Railway** as the default target: Postgres 18 (`postgres-ssl:18`), the API on the private
  network only, the web server with a public domain; the API's migration runs before each deploy;
  a deploy waits for CI; each service redeploys only when its watch paths change
  ([deployment-railway.md](../deployment-railway.md)).
- **Infrastructure as code, experimental**: `.railway/railway.ts` with Railway's TypeScript SDK
  (`railway` 3.13.0, a beta, pinned exactly), tested offline (`pnpm nx run railway-iac:test`) and
  applied by a human (`railway config plan`, then `apply`). The same setup is documented for the
  dashboard, in case the SDK breaks. No `railway.json`: Railway's earlier Config as Code is
  deprecated.
- Agents never log in to Railway: every `railway` command asks a human first.

## Consequences

- The images run on any container platform; only `.railway/` and the docs know about Railway.
- The API's secret (`INTERNAL_API_SECRET`) is shared by two services and checked on every request
  in production; the web server's BFF is the only door.
- An `apply` deletes what the file leaves out (a variable set in the dashboard, say): the file must
  stay the source of truth.
- The Railway "Deploy" button needs a template published on Railway itself; it is a launch task,
  not part of the repository.
- Image builds reinstall everything when the lockfile changes (about 50 s): Railway rejects the
  BuildKit cache mounts that would avoid it.

## Alternatives considered

- **Vercel**: excellent for the web app, less natural for a long-running Node API kept off the
  internet behind private networking.
- **Fly.io, Render**: good container platforms with private networking; the images run there as
  they are, with the platform's own config instead of `.railway/`.
- **Kubernetes or a VM**: full control, far more to operate than a template should assume.
- **Railway's `railway.json` / `railway.toml`**: deprecated; new services cannot use them.
