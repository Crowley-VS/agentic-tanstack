#!/usr/bin/env node
// This checkout's local Postgres (docker-compose.yml at the repo root), one compose project per
// checkout/worktree with names and ports from tools/dev-ports.mjs.
//
//   node scripts/db-up.mjs          start it (~1 s cold; ~10 ms when it is already running: no Docker call)
//   node scripts/db-up.mjs down     stop it (data kept); succeeds when Docker is not running
//   node scripts/db-up.mjs prune    remove the containers, volumes and networks of this repository's
//                                   deleted checkouts (scripts/orphans.mjs); `up` does it too
//                                   whenever it has to start the server
//   node scripts/db-up.mjs reset    delete it and its data, then start fresh
//   node scripts/db-up.mjs psql     open psql on the dev database; arguments after `psql` go to
//                                   psql (`-c "select …"` runs one query, also without a terminal)
//   node scripts/db-up.mjs studio   Drizzle Studio on this checkout's studio port
//
// Also imported by the Vitest global setup (`dbUp()`) and the migrate/seed scripts (`resolveDb()`,
// `isLocalUrl()`).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describePruned, pruneOrphans } from './orphans.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Ports and names from the repo's `tools/dev-ports.mjs` (the single source for them), asked as a
 * child process rather than imported: the db project must not import the tools project.
 */
function devPorts(cwd, env) {
  const root = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  }).stdout?.trim();
  if (!root) fail(`not inside a git checkout: ${cwd}`);
  const res = spawnSync(process.execPath, [join(root, 'tools', 'dev-ports.mjs'), '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  if (res.status !== 0) fail(`tools/dev-ports.mjs failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

/** Where this checkout's database lives; no Docker call. */
export function resolveDb(cwd = HERE, env = process.env) {
  const info = devPorts(cwd, env);
  return {
    project: info.composeProject,
    port: info.ports.db,
    studioPort: info.ports.studio,
    // explicit DATABASE_URL (CI, prod-like runs) wins over the per-checkout one
    url: env.DATABASE_URL ?? info.databaseUrls.dev,
    // the e2e servers' database (db-seed-e2e recreates it on every e2e run): never DATABASE_URL
    e2eUrl: env.E2E_DATABASE_URL ?? info.databaseUrls.e2e,
    adminUrl: env.TEST_DATABASE_URL ?? info.databaseUrls.test,
    // per checkout, like the dev database: app → test_template, app_<hash> → test_template_<hash>
    testTemplate: new URL(info.databaseUrls.dev).pathname.slice(1).replace(/^app/, 'test_template'),
    composeFile: join(info.root, 'docker-compose.yml'),
    primary: info.primary,
    // the labels docker-compose.yml puts on the container and volume (scripts/orphans.mjs)
    root: info.root,
    commonDir: info.commonDir,
  };
}

/** True for a database URL on this machine (127.0.0.1, localhost, ::1), never a remote host. */
export function isLocalUrl(url) {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname);
}

/** Postgres keeps the first 63 bytes of cluster_name (NAMEDATALEN - 1); project names are ASCII. */
export function isOurCluster(clusterName, project) {
  return clusterName === project.slice(0, 63);
}

/** True if OUR server answers on the port (cluster_name == compose project), in ~10 ms. */
async function answers({ adminUrl, project }) {
  const client = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 1000 });
  try {
    await client.connect();
    const { rows } = await client.query('show cluster_name');
    return isOurCluster(rows[0]?.cluster_name, project);
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

function fail(message) {
  throw Object.assign(new Error(`[db-up] ${message}`), { dbUp: true });
}

// stdout too is piped by default: `up` prints nothing useful there, only compose's question about a
// volume made before docker-compose.yml labeled volumes, which takes its default (no: keep the
// data) since stdin is no terminal
function compose(cfg, args, { stdio = ['ignore', 'pipe', 'pipe'], env = process.env } = {}) {
  return spawnSync('docker', ['compose', '-p', cfg.project, '-f', cfg.composeFile, ...args], {
    env: {
      ...env,
      DB_PORT: String(cfg.port),
      COMPOSE_PROJECT_NAME: cfg.project,
      DEV_CHECKOUT_ROOT: cfg.root ?? '',
      DEV_CHECKOUT_GIT_COMMON_DIR: cfg.commonDir ?? '',
    },
    encoding: 'utf8',
    stdio,
  });
}

/**
 * Docker is missing or its daemon is not running (from a failed docker call's result); not when
 * it runs but refuses this user, whose containers may be running.
 */
function noDocker(res) {
  return (
    res.error?.code === 'ENOENT' ||
    /Cannot connect to the Docker daemon|Is the docker daemon running/i.test(res.stderr ?? '')
  );
}

/**
 * Remove the Docker leftovers of this repository's deleted checkouts, printing what went. Never
 * fails: db-up runs it on its way to `compose up`, which reports a Docker that does not answer.
 */
function pruneQuietly(cfg, env) {
  try {
    const pruned = pruneOrphans(cfg, { env });
    for (const line of describePruned(pruned)) console.log(`[db-up] ${line}`);
    for (const line of pruned.failed) console.error(`[db-up] could not prune: ${line}`);
  } catch {
    // Docker is not installed or not running: `compose up` says so
  }
}

/** Start this checkout's Postgres if it is not running, and wait until it accepts connections. */
export async function dbUp(cfg = resolveDb(), { env = process.env } = {}) {
  // this checkout's server: on this machine, on its port (a Postgres URL without one means 5432)
  const ours = (url) => isLocalUrl(url) && Number(new URL(url).port || 5432) === cfg.port;
  // DATABASE_URL / TEST_DATABASE_URL point elsewhere (CI, prod-like runs): not ours to start
  if (!ours(cfg.url) && !ours(cfg.adminUrl) && !env.DB_UP_FORCE) return cfg;
  if (await answers(cfg)) return cfg;
  // Docker gets called anyway: clear deleted checkouts' leftovers first (their containers may hold
  // a port the registry has since handed to a new worktree)
  pruneQuietly(cfg, env);
  let res = compose(cfg, ['up', '-d', '--wait'], { env });
  // a concurrent `up` of this project (another Nx process or terminal) created it first: wait on it
  if (/is already in use by container|already exists/i.test(res.stderr ?? ''))
    res = compose(cfg, ['up', '-d', '--wait'], { env });
  const err = res.stderr ?? '';
  if (res.error?.code === 'ENOENT')
    fail('Docker is not installed (no `docker` on PATH). Install Docker Engine with Compose v2.');
  if (/Cannot connect to the Docker daemon|Is the docker daemon running|docker\.sock/i.test(err))
    fail(
      `Docker is not running. Start it and retry.\n  docker said: ${err.trim().split('\n').at(-1)}`,
    );
  if (/port is already allocated|address already in use/i.test(err)) {
    compose(cfg, ['down'], { stdio: 'ignore', env }); // drop the half-created container (it would restart without the port)
    fail(`Port ${cfg.port} is taken by something else. Retry with DB_PORT=<free port>.`);
  }
  if (res.status !== 0) fail(`docker compose up failed (exit ${res.status}):\n${err}`);
  if (!(await answers(cfg)))
    fail(
      `compose reports ${cfg.project} healthy but ${cfg.port} does not reach it. Run \`pnpm nx run db:db-down\` and retry.`,
    );
  return cfg;
}

/**
 * `compose exec` arguments for psql on `db`, followed by the caller's own psql arguments. Without
 * a terminal on stdin (an agent's shell, a pipe) compose must not allocate one: `-T`.
 */
export function psqlArgs(db, args = [], { tty = process.stdin.isTTY } = {}) {
  return ['exec', ...(tty ? [] : ['-T']), 'postgres', 'psql', '-U', 'postgres', '-d', db, ...args];
}

async function main([mode = 'up', ...args]) {
  const cfg = resolveDb();
  if (mode === 'up') {
    const t0 = performance.now();
    await dbUp(cfg);
    console.log(
      `[db-up] ${cfg.project} ready on :${cfg.port} (${Math.round(performance.now() - t0)} ms)`,
    );
  } else if (mode === 'down') {
    // `pnpm teardown` runs this in every checkout: nothing runs without Docker, so nothing to stop
    const res = compose(cfg, ['down'], { stdio: ['ignore', 'inherit', 'pipe'] });
    if (noDocker(res)) {
      console.log(`[db-up] Docker is not running: nothing to stop for ${cfg.project}`);
      return;
    }
    process.stderr.write(res.stderr ?? '');
    process.exitCode = res.status ?? 1;
  } else if (mode === 'prune') {
    let pruned;
    try {
      pruned = pruneOrphans(cfg);
    } catch (err) {
      if (!err.docker) throw err;
      console.log(`[db-up] ${err.message}: no containers or volumes to prune`);
      return;
    }
    const lines = describePruned(pruned);
    for (const line of lines.length ? lines : ['no leftovers of deleted checkouts'])
      console.log(`[db-up] ${line}`);
    for (const line of pruned.failed) console.error(`[db-up] could not prune: ${line}`);
    if (pruned.failed.length) process.exitCode = 1;
  } else if (mode === 'reset') {
    compose(cfg, ['down', '-v'], { stdio: 'inherit' });
    await dbUp(cfg);
    console.log(`[db-up] ${cfg.project} reset: empty server on :${cfg.port}`);
  } else if (mode === 'psql') {
    await dbUp(cfg);
    const db = new URL(cfg.url).pathname.slice(1);
    process.exitCode = compose(cfg, psqlArgs(db, args), { stdio: 'inherit' }).status ?? 1;
  } else if (mode === 'studio') {
    // drizzle-kit's default port (4983) would collide across worktrees: use this checkout's own
    const bin = join(dirname(createRequire(import.meta.url).resolve('drizzle-kit')), 'bin.cjs');
    const studioArgs = [bin, 'studio', '--host', '127.0.0.1', '--port', String(cfg.studioPort)];
    process.exitCode =
      spawnSync(process.execPath, studioArgs, { cwd: join(HERE, '..'), stdio: 'inherit' }).status ??
      1;
  } else {
    console.error('usage: node scripts/db-up.mjs [up|down|prune|reset|psql [psql args]|studio]');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.dbUp ? err.message : err);
    process.exit(1);
  });
}
