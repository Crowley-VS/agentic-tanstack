// Railway infrastructure as code: one Railway environment's Postgres, private API and public web
// app. EXPERIMENTAL: the `railway` SDK is a beta with breaking changes announced, pinned exactly in
// the catalog; docs/deployment-railway.md sets up the same project in the dashboard instead.
//
// The Railway CLI (5.42.1 or newer) evaluates this file with Node's type stripping on
// `railway config plan` and `railway config apply`: erasable TypeScript only, no imports but
// `railway/iac`. `pnpm nx run railway-iac:test` evaluates it the same way, offline.
//
// An apply makes the environment match this file: a service or variable missing here is deleted
// (marked destructive in the plan; volumes are never deleted). Two things it cannot hold, set once
// per environment (docs/deployment-railway.md):
//   - the shared variable INTERNAL_API_SECRET: `ctx.shared` refers to it, never creates it;
//   - web's public *.up.railway.app domain: generated domains are not part of the file.
import { defineRailway, github, postgres, project, service } from 'railway/iac';

/** The GitHub repository Railway builds from. Bootstrap replaces it with yours. */
const REPO = 'Crowley-VS/agentic-tanstack';

/**
 * Watch paths (gitignore-style, from the repository root): a push redeploys a service only when it
 * changes one of its paths. Each app's own directory, the workspace packages its image bundles
 * (its `@acme/*` dependencies, transitively: the test checks), and the files every install reads.
 * The lockfile is shared, so any dependency change redeploys both apps.
 */
const WORKSPACE_FILES = [
  '/package.json',
  '/pnpm-lock.yaml',
  '/pnpm-workspace.yaml',
  '/nx.json',
  '/tsconfig.base.json',
  '/tsconfig.json',
  '/.dockerignore',
];

/** Both apps listen on the same fixed port: web's domain and API_PORT point at it. */
const PORT = '8080';

/**
 * Seconds between SIGTERM and SIGKILL when a deploy replaces a container (Railway's default: 0).
 * Covers both servers' own limits: the API forces its exit at 8 s, srvx (web) at 5 s.
 */
const DRAINING_SECONDS = 10;

export default defineRailway((ctx) => {
  const db = postgres('Postgres'); // ghcr.io/railwayapp-templates/postgres-ssl:18 (Debian trixie)

  // Private: no domain. Only web reaches it, at api.railway.internal:8080.
  const api = service('api', {
    // checkSuites: a push deploys only after its GitHub checks (CI) pass
    source: github(REPO, { branch: 'main', checkSuites: true }),
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: 'apps/api/Dockerfile',
      watchPatterns: [
        '/apps/api/**',
        '/packages/core/**',
        '/packages/db/**',
        '/packages/logger/**',
        '/packages/validators/**',
        ...WORKSPACE_FILES,
      ],
    },
    // in its own container from the new image, on the private network; a failure stops the deploy
    preDeploy: 'node dist/migrate.mjs',
    healthcheck: '/health',
    deploy: { drainingSeconds: DRAINING_SECONDS },
    env: {
      PORT,
      DATABASE_URL: db.env.DATABASE_URL,
      INTERNAL_API_SECRET: ctx.shared.INTERNAL_API_SECRET,
    },
  });

  const web = service('web', {
    source: github(REPO, { branch: 'main', checkSuites: true }),
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: 'apps/web/Dockerfile',
      watchPatterns: [
        '/apps/web/**',
        '/packages/logger/**',
        '/packages/ui/**',
        '/packages/validators/**',
        ...WORKSPACE_FILES,
      ],
    },
    healthcheck: '/api/health',
    deploy: { drainingSeconds: DRAINING_SECONDS },
    env: {
      PORT,
      API_HOST: api.env.RAILWAY_PRIVATE_DOMAIN,
      API_PORT: api.env.PORT,
      INTERNAL_API_SECRET: ctx.shared.INTERNAL_API_SECRET,
      // REAL_IP_HEADER (x-real-ip) and EDGE_REQUEST_ID_HEADER (x-railway-request-id) keep their
      // defaults: Railway's edge sets both on every request (docs/production.md)
    },
  });

  return project('acme-app', { resources: [db, api, web] });
});
