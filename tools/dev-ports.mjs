#!/usr/bin/env node
// Deterministic ports + names per checkout, so parallel worktrees (and the agents
// running in them) never fight over ports or share a database.
//
//   primary checkout  -> fixed, memorable defaults (web 3000, api 4000, db 5432)
//   linked worktree   -> a block derived from a hash of the worktree path
//   env overrides     -> WEB_PORT, API_PORT, DB_PORT, WEB_E2E_PORT, API_E2E_PORT, COMPOSE_PROJECT_NAME
//
// Usage:
//   node tools/dev-ports.mjs --print          human-readable URLs
//   node tools/dev-ports.mjs --json           machine-readable
//   node tools/dev-ports.mjs --get web        one value (port or url key)
//   node tools/dev-ports.mjs --env            KEY=VALUE lines
//   node tools/dev-ports.mjs --exec -- <cmd>  run cmd with the env injected (existing env wins)
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRIMARY = { web: 3000, api: 4000, db: 5432, webE2e: 3100, apiE2e: 4100 };
const OFFSETS = { web: 0, api: 1, db: 2, webE2e: 10, apiE2e: 11 };
const ENV_KEYS = {
  web: 'WEB_PORT',
  api: 'API_PORT',
  db: 'DB_PORT',
  webE2e: 'WEB_E2E_PORT',
  apiE2e: 'API_E2E_PORT',
};

/** Detect the checkout root and whether it is the primary checkout (not a linked worktree). */
export function detectCheckout(cwd = process.cwd()) {
  try {
    const git = (...args) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    const root = git('rev-parse', '--show-toplevel');
    const gitDir = resolve(cwd, git('rev-parse', '--git-dir'));
    const commonDir = resolve(cwd, git('rev-parse', '--git-common-dir'));
    return { root, primary: gitDir === commonDir };
  } catch {
    return { root: resolve(cwd), primary: true };
  }
}

/** Short stable hash of a path. */
export function pathHash(path) {
  return createHash('sha256').update(path).digest('hex').slice(0, 8);
}

/** Pure: compute ports and names for a checkout. */
export function computePorts({ root, primary }, env = {}) {
  const hash = pathHash(root);
  let ports;
  if (primary) {
    ports = { ...PRIMARY };
  } else {
    // 400 blocks of 100 ports in 20000-59999; the block is chosen by the path hash.
    const base = 20000 + (Number.parseInt(hash, 16) % 400) * 100;
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
  const composeProject = env.COMPOSE_PROJECT_NAME || (primary ? slug : `${slug}-${hash}`);
  const dbUrl = (db) => `postgres://postgres:postgres@127.0.0.1:${ports.db}/${db}`;
  return {
    primary,
    root,
    composeProject,
    ports,
    urls: {
      web: `http://localhost:${ports.web}`,
      api: `http://localhost:${ports.api}/graphql`,
      webE2e: `http://localhost:${ports.webE2e}`,
      apiE2e: `http://localhost:${ports.apiE2e}/graphql`,
    },
    databaseUrls: { dev: dbUrl('app'), e2e: dbUrl('e2e'), test: dbUrl('postgres') },
  };
}

/** Environment variables handed to dev/e2e processes. */
export function toEnv(info) {
  return {
    WEB_PORT: String(info.ports.web),
    API_PORT: String(info.ports.api),
    DB_PORT: String(info.ports.db),
    WEB_E2E_PORT: String(info.ports.webE2e),
    API_E2E_PORT: String(info.ports.apiE2e),
    API_HOST: 'localhost',
    COMPOSE_PROJECT_NAME: info.composeProject,
    DATABASE_URL: info.databaseUrls.dev,
    E2E_DATABASE_URL: info.databaseUrls.e2e,
    TEST_DATABASE_URL: info.databaseUrls.test,
  };
}

function main(argv) {
  const info = computePorts(detectCheckout(), process.env);
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
      console.log(value);
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
      console.log(`  e2e web    ${info.urls.webE2e}`);
      console.log(`  e2e api    ${info.urls.apiE2e}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
