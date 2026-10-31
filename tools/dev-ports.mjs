#!/usr/bin/env node
// Deterministic ports + names per checkout, so parallel worktrees (and the agents
// running in them) never fight over ports or share a database.
//
//   primary checkout  -> fixed, memorable defaults (web 3000, api 4000, db 5432, Drizzle Studio
//                        4983, the production images' stack 3200) and databases app / e2e
//   linked worktree   -> its own block of 100 ports in 20000-59999, recorded in
//                        <git common dir>/dev-ports.json: the block its path hashes to, or the
//                        next free one, so no two worktrees of this repository share a block;
//                        its own compose project (so its own Postgres), and databases named
//                        app_<hash> / e2e_<hash>, which stay apart even when an override
//                        points several worktrees at one Postgres server
//   env overrides     -> WEB_PORT, API_PORT, DB_PORT, DB_STUDIO_PORT, WEB_E2E_PORT, API_E2E_PORT,
//                        STACK_PORT, COMPOSE_PROJECT_NAME, STACK_PROJECT (`ownsComposeProject` /
//                        `ownsStackProject` are false when they name a project other than the
//                        checkout's own)
//   .env.local        -> the same port variables, kept with the checkout: its gitignored dotenv
//                        file, which no worktree copies and Nx loads into every task (so the e2e
//                        targets Nx infers follow it); the environment still wins. For a primary
//                        checkout whose fixed ports another one already uses
//   test database URL -> the server's `postgres` maintenance database, for tests that create
//                        databases of their own
//
// Usage:
//   node tools/dev-ports.mjs --print          human-readable URLs
//   node tools/dev-ports.mjs --json           machine-readable
//   node tools/dev-ports.mjs --get web        one value (port or url key)
//   node tools/dev-ports.mjs --env            KEY=VALUE lines
//   node tools/dev-ports.mjs --exec -- <cmd>  run cmd with the env injected (existing env wins)
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const BLOCKS = 400; // blocks of 100 ports in 20000-59999
const REGISTRY = 'dev-ports.json';
// stack: the web server of the production images' local stack (docker-compose.stack.yml)
const PRIMARY = {
  web: 3000,
  api: 4000,
  db: 5432,
  studio: 4983,
  webE2e: 3100,
  apiE2e: 4100,
  stack: 3200,
};
const OFFSETS = { web: 0, api: 1, db: 2, studio: 3, webE2e: 10, apiE2e: 11, stack: 20 };
const ENV_KEYS = {
  web: 'WEB_PORT',
  api: 'API_PORT',
  db: 'DB_PORT',
  studio: 'DB_STUDIO_PORT',
  webE2e: 'WEB_E2E_PORT',
  apiE2e: 'API_E2E_PORT',
  stack: 'STACK_PORT',
};

/** An env flag that is on: set, and neither `0` nor `false`. */
const enabled = (value) => Boolean(value) && value !== '0' && value !== 'false';

/**
 * Detect the checkout root, whether it is the primary checkout (not a linked worktree), and the
 * git directory shared by all worktrees (where the port registry lives).
 */
export function detectCheckout(cwd = process.cwd()) {
  try {
    const git = (...args) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    const root = git('rev-parse', '--show-toplevel');
    // real paths: every checkout of the repository spells its common dir the same way (it is how
    // `prune` recognises this repository's Docker resources, see docker-compose.yml)
    const gitDir = realpathSync(resolve(cwd, git('rev-parse', '--git-dir')));
    const commonDir = realpathSync(resolve(cwd, git('rev-parse', '--git-common-dir')));
    return { root, primary: gitDir === commonDir, commonDir };
  } catch {
    return { root: resolve(cwd), primary: true };
  }
}

/** Short stable hash of a path. */
export function pathHash(path) {
  return createHash('sha256').update(path).digest('hex').slice(0, 8);
}

/** The block a worktree path prefers (used when it is free, and when there is no registry). */
export function preferredBlock(root) {
  return Number.parseInt(pathHash(root), 16) % BLOCKS;
}

/**
 * Pure: the block for `root` given the registry { worktree path: block } — its recorded block,
 * else its preferred block, else the next free one after it.
 */
export function assignBlock(registry, root) {
  if (Number.isInteger(registry[root])) return registry[root];
  const used = new Set(Object.values(registry));
  const preferred = preferredBlock(root);
  for (let i = 0; i < BLOCKS; i++) {
    const block = (preferred + i) % BLOCKS;
    if (!used.has(block)) return block;
  }
  return preferred; // all 400 blocks taken: share one rather than fail
}

function withLock(lockDir, fn) {
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lockDir); // atomic: fails with EEXIST while another process holds the lock
      break;
    } catch (err) {
      if (err.code !== 'EEXIST' || attempt > 200) throw err;
      if (attempt === 120) rmSync(lockDir, { recursive: true, force: true }); // stale (~3 s)
      Atomics.wait(sleep, 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/**
 * This worktree's block from the registry in the git common dir, claiming one on first use and
 * dropping worktrees whose directories are gone. Returns undefined when the registry cannot be
 * used (e.g. read-only .git); callers then fall back to the preferred block.
 */
export function worktreeBlock(root, commonDir, { exists = existsSync } = {}) {
  const file = join(commonDir, REGISTRY);
  try {
    return withLock(`${file}.lock`, () => {
      let current = {};
      try {
        current = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        // missing or corrupt: start over
      }
      const registry = Object.fromEntries(
        Object.entries(current).filter(([path, block]) => Number.isInteger(block) && exists(path)),
      );
      const block = assignBlock(registry, root);
      registry[root] = block;
      if (JSON.stringify(registry) !== JSON.stringify(current)) {
        writeFileSync(`${file}.tmp`, `${JSON.stringify(registry, null, 2)}\n`);
        renameSync(`${file}.tmp`, file);
      }
      return block;
    });
  } catch {
    return undefined;
  }
}

/**
 * Pure: compute ports and names for a checkout (`block`: the worktree's registry block;
 * `commonDir`: the directory all worktrees of the repository share, passed through).
 */
export function computePorts({ root, primary, block, commonDir }, env = {}) {
  const hash = pathHash(root);
  let ports;
  if (primary) {
    ports = { ...PRIMARY };
  } else {
    const base = 20000 + (Number.isInteger(block) ? block : preferredBlock(root)) * 100;
    ports = Object.fromEntries(Object.entries(OFFSETS).map(([k, off]) => [k, base + off]));
  }
  for (const [key, envKey] of Object.entries(ENV_KEYS)) {
    if (env[envKey]) ports[key] = Number(env[envKey]);
  }
  const slug =
    basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '') || 'app';
  const ownProject = primary ? slug : `${slug}-${hash}`;
  const composeProject = env.COMPOSE_PROJECT_NAME || ownProject;
  const stackProject = env.STACK_PROJECT || `${composeProject}-stack`;
  const dbUrl = (db) => `postgres://postgres:postgres@127.0.0.1:${ports.db}/${db}`;
  const dbName = (name) => (primary ? name : `${name}_${hash}`);
  return {
    primary,
    root,
    commonDir,
    composeProject,
    // false when COMPOSE_PROJECT_NAME names another project (one server shared by several
    // checkouts, say): db-up then labels nothing as this checkout's, so `prune` never removes it
    ownsComposeProject: composeProject === ownProject,
    // the compose project of the production images' stack (docker-compose.stack.yml)
    stackProject,
    // false when STACK_PROJECT or COMPOSE_PROJECT_NAME names a project other than the checkout's
    // own, which may be another checkout's: stack-down then leaves it, and nothing labels it as
    // this checkout's. In CI the project STACK_PROJECT names is the run's own (one checkout per
    // runner)
    ownsStackProject:
      stackProject === `${ownProject}-stack` || (enabled(env.CI) && Boolean(env.STACK_PROJECT)),
    ports,
    urls: {
      web: `http://localhost:${ports.web}`,
      api: `http://localhost:${ports.api}/graphql`,
      webE2e: `http://localhost:${ports.webE2e}`,
      apiE2e: `http://localhost:${ports.apiE2e}/graphql`,
      // published on 127.0.0.1 only: `localhost` may try ::1 first
      stack: `http://127.0.0.1:${ports.stack}`,
    },
    databaseUrls: {
      dev: dbUrl(dbName('app')),
      e2e: dbUrl(dbName('e2e')),
      test: dbUrl('postgres'),
    },
  };
}

/** Environment variables handed to dev/e2e processes. */
export function toEnv(info) {
  // the labels docker-compose.stack.yml puts on what it creates (packages/db/scripts/orphans.mjs
  // reads them), only for this checkout's own stack (db-up labels docker-compose.yml's itself)
  const own = info.ownsStackProject === true;
  return {
    WEB_PORT: String(info.ports.web),
    API_PORT: String(info.ports.api),
    DB_PORT: String(info.ports.db),
    DB_STUDIO_PORT: String(info.ports.studio),
    WEB_E2E_PORT: String(info.ports.webE2e),
    API_E2E_PORT: String(info.ports.apiE2e),
    STACK_PORT: String(info.ports.stack),
    API_HOST: 'localhost',
    COMPOSE_PROJECT_NAME: info.composeProject,
    STACK_PROJECT: info.stackProject,
    DEV_CHECKOUT_ROOT: (own && info.root) || '',
    DEV_CHECKOUT_GIT_COMMON_DIR: (own && info.commonDir) || '',
    DATABASE_URL: info.databaseUrls.dev,
    E2E_DATABASE_URL: info.databaseUrls.e2e,
    TEST_DATABASE_URL: info.databaseUrls.test,
  };
}

/**
 * The port variables `.env.local` at `root` sets: the checkout's dotenv file, which Nx also loads
 * into every task, and whose change makes Nx infer the e2e targets (their readiness URLs) again.
 * Only the port variables are read; one whose value is no port throws, rather than being ignored.
 */
export function localOverrides(root) {
  const file = join(root, '.env.local');
  if (!existsSync(file)) return {};
  const values = parseEnv(readFileSync(file, 'utf8'));
  const overrides = {};
  for (const key of Object.values(ENV_KEYS)) {
    if (!values[key]) continue;
    if (!/^\d{2,5}$/.test(values[key]))
      throw new Error(`dev-ports: .env.local sets ${key}="${values[key]}", which is no port`);
    overrides[key] = values[key];
  }
  return overrides;
}

/** Ports, names and URLs for the checkout that contains `cwd` (what `--json` prints). */
export function resolveInfo(cwd = process.cwd(), env = process.env) {
  const checkout = detectCheckout(cwd);
  const block =
    checkout.primary || !checkout.commonDir
      ? undefined
      : worktreeBlock(checkout.root, checkout.commonDir);
  return computePorts({ ...checkout, block }, { ...localOverrides(checkout.root), ...env });
}

function main(argv) {
  let info;
  try {
    info = resolveInfo();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const [flag, ...rest] = argv;
  switch (flag) {
    case '--json':
      console.log(JSON.stringify(info, null, 2));
      return;
    case '--get': {
      const key = rest[0];
      const value = info.urls[key] ?? info.ports[key] ?? info.databaseUrls[key] ?? info[key];
      if (value === undefined) {
        console.error(`dev-ports: unknown key "${key}"`);
        process.exit(1);
      }
      console.log(String(value)); // a port is a number: never colored, even with FORCE_COLOR
      return;
    }
    case '--env':
      for (const [k, v] of Object.entries(toEnv(info))) console.log(`${k}=${v}`);
      return;
    case '--exec': {
      const cmd = rest[0] === '--' ? rest.slice(1) : rest;
      if (cmd.length === 0) {
        console.error('dev-ports: --exec needs a command, e.g. --exec -- node server.js');
        process.exit(1);
      }
      // Existing env wins, so callers (CI, e2e targets) can override anything.
      const env = { ...toEnv(info), ...process.env };
      const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env, shell: false });
      // e.g. not on PATH: a clear message and the shell's "command not found" code, not a stack
      child.on('error', (err) => {
        console.error(`dev-ports: could not start ${cmd[0]}: ${err.message}`);
        process.exit(127);
      });
      for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
      child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
      return;
    }
    default: {
      const where = info.primary ? 'primary checkout' : `worktree (${info.composeProject})`;
      console.log(`Dev URLs for this ${where}:`);
      console.log(`  web        ${info.urls.web}`);
      console.log(`  api        ${info.urls.api}`);
      console.log(`  postgres   ${info.databaseUrls.dev}`);
      console.log(`  db studio  https://local.drizzle.studio?port=${info.ports.studio}`);
      console.log(`  e2e web    ${info.urls.webE2e}`);
      console.log(`  e2e api    ${info.urls.apiE2e}`);
      console.log(
        `  stack web  ${info.urls.stack} (production images: pnpm nx run web-e2e:stack-up)`,
      );
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
