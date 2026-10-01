// scripts/db-up.mjs without Docker: a fake `docker`, alone on PATH, logs its arguments and answers
// `compose up` as each test scripts it, and the server's port is closed, so nothing ever answers.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script
import { dbUp, isLocalUrl, isOurCluster, resolveDb } from '../scripts/db-up.mjs';

const DB = join(import.meta.dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'db-up-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// FAKE_DOCKER_UP: the replies to successive `compose up` calls, [{ stderr, status }] (default: ok)
const BIN = join(tmp, 'bin');
mkdirSync(BIN);
writeFileSync(
  join(tmp, 'docker.mjs'),
  `import { appendFileSync, readFileSync } from 'node:fs';
const { FAKE_DOCKER_LOG: log, FAKE_DOCKER_UP: up = '[]' } = process.env;
appendFileSync(log, process.argv.slice(2).join(' ') + '\\n');
if (process.argv.includes('up')) {
  const n = readFileSync(log, 'utf8').split('\\n').filter((l) => l.split(' ').includes('up')).length;
  const { stderr = '', status = 0 } = JSON.parse(up)[n - 1] ?? {};
  process.stderr.write(stderr);
  process.exit(status);
}
`,
);
writeFileSync(
  join(BIN, 'docker'),
  `#!/bin/sh\nexec "${process.execPath}" "${join(tmp, 'docker.mjs')}" "$@"\n`,
);
chmodSync(join(BIN, 'docker'), 0o755);

const COMPOSE = `compose -p fake-project -f ${join(tmp, 'docker-compose.yml')}`;
const UP = `${COMPOSE} up -d --wait`;

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** What resolveDb() returns for a checkout whose server would be on `port`. */
const local = (port: number) => ({
  project: 'fake-project',
  port,
  url: `postgres://postgres:postgres@127.0.0.1:${port}/app`,
  adminUrl: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
  composeFile: join(tmp, 'docker-compose.yml'),
});

let runs = 0;
/** dbUp() against the fake docker: the message it failed with (if any) and the docker calls. */
async function run(
  cfg: ReturnType<typeof local>,
  { up = [], env = {} }: { up?: object[]; env?: Record<string, string> } = {},
) {
  const log = join(tmp, `docker-${runs++}.log`);
  const fakeEnv = { PATH: BIN, FAKE_DOCKER_LOG: log, FAKE_DOCKER_UP: JSON.stringify(up), ...env };
  const error: string | undefined = await dbUp(cfg, { env: fakeEnv }).then(
    () => undefined,
    (err: Error) => err.message,
  );
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  return { error, calls };
}

describe('dbUp', () => {
  it('leaves a server that is not this checkout’s alone (no Docker call), unless DB_UP_FORCE', async () => {
    const [port, other] = [await closedPort(), await closedPort()];
    const remote = {
      ...local(port),
      url: 'postgres://u:p@db.example.com:5432/app',
      adminUrl: 'postgres://u:p@db.example.com:5432/postgres',
    };
    expect(await run(remote)).toEqual({ error: undefined, calls: [] });
    // another port on this machine is another server too
    const elsewhere = { ...local(port), url: local(other).url, adminUrl: local(other).adminUrl };
    expect(await run(elsewhere)).toEqual({ error: undefined, calls: [] });
    expect((await run(elsewhere, { env: { DB_UP_FORCE: '1' } })).calls).toEqual([UP]);
  });

  it('starts this checkout’s server even when DATABASE_URL names it (dev-ports --env exports it)', async () => {
    const cfg = local(await closedPort());
    expect((await run(cfg, { env: { DATABASE_URL: cfg.url } })).calls).toEqual([UP]);
    // either URL on this checkout's server is enough
    const remoteDev = { ...cfg, url: 'postgres://u:p@db.example.com:5432/app' };
    expect((await run(remoteDev)).calls).toEqual([UP]);
  });

  it('says so when Docker is not installed', async () => {
    const { error } = await run(local(await closedPort()), { env: { PATH: join(tmp, 'none') } });
    expect(error).toContain('Docker is not installed (no `docker` on PATH)');
  });

  it('says so when the Docker daemon is not running', async () => {
    const stderr =
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n';
    const { error, calls } = await run(local(await closedPort()), { up: [{ stderr, status: 1 }] });
    expect(calls).toEqual([UP]);
    expect(error).toContain('Docker is not running. Start it and retry.');
    expect(error).toContain('docker said: Cannot connect to the Docker daemon');
  });

  it('removes the half-created container when the port is taken', async () => {
    const cfg = local(await closedPort());
    const stderr = `Error response from daemon: driver failed programming external connectivity on endpoint fake-project-postgres-1: Bind for 127.0.0.1:${cfg.port} failed: port is already allocated\n`;
    const { error, calls } = await run(cfg, { up: [{ stderr, status: 1 }] });
    expect(calls).toEqual([UP, `${COMPOSE} down`]);
    expect(error).toContain(`Port ${cfg.port} is taken by something else.`);
  });

  it('retries `up` once when a concurrent start created the container first', async () => {
    const stderr =
      'Error response from daemon: Conflict. The container name "/fake-project-postgres-1" is already in use by container "0123abcd".\n';
    const { error, calls } = await run(local(await closedPort()), {
      up: [{ stderr, status: 1 }, {}],
    });
    expect(calls).toEqual([UP, UP]);
    // the retry succeeded; only the check that the port reaches the server is left
    expect(error).toMatch(/healthy but \d+ does not reach it/);
  });

  it('reports any other compose failure as is, without retrying', async () => {
    const { error, calls } = await run(local(await closedPort()), {
      up: [{ stderr: 'pull access denied\n', status: 18 }],
    });
    expect(calls).toEqual([UP]);
    expect(error).toContain('docker compose up failed (exit 18):\npull access denied');
  });

  it('fails when compose reports the server healthy but its port does not reach it', async () => {
    const cfg = local(await closedPort());
    const { error, calls } = await run(cfg, { up: [{}] });
    expect(calls).toEqual([UP]);
    expect(error).toContain(
      `compose reports fake-project healthy but ${cfg.port} does not reach it`,
    );
  });
});

describe('isOurCluster', () => {
  it('matches the first 63 bytes of the project name, all of cluster_name Postgres keeps', () => {
    const long = `${'a-worktree-named-after-its-long-branch-'.repeat(2)}0123abcd`;
    expect(isOurCluster(long.slice(0, 63), long)).toBe(true);
    expect(isOurCluster('m2-d2586537', 'm2-d2586537')).toBe(true);
    expect(isOurCluster('m2-d2586537', 'other-d2586537')).toBe(false);
    expect(isOurCluster(undefined, 'm2-d2586537')).toBe(false);
  });
});

describe('isLocalUrl', () => {
  it('accepts only this machine’s host names, exactly', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]'])
      expect(isLocalUrl(`postgres://u:p@${host}:5432/app`), host).toBe(true);
    for (const host of ['localhost.example.com', '127.0.0.1.nip.io', 'db-localhost.corp.net'])
      expect(isLocalUrl(`postgres://u:p@${host}:5432/app`), host).toBe(false);
  });

  it('makes db-migrate refuse a remote database, naming the opt-in', () => {
    const res = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts'], {
      cwd: DB,
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: 'postgres://u:p@db.example.com:5432/app',
        DB_ALLOW_REMOTE: '',
      },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(
      '[db] refusing to migrate a non-local database (db.example.com); set DB_ALLOW_REMOTE=1',
    );
    // a cold tsx start under CI load takes about 6 s (0.4 s warm): more than Vitest's 5 s default
  }, 30_000);

  it('makes db-seed-e2e refuse a remote e2e database, with no opt-in, and never use DATABASE_URL', () => {
    const res = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/seed-e2e.ts'], {
      cwd: DB,
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: 'postgres://u:p@db.example.com:5432/app',
        E2E_DATABASE_URL: 'postgres://u:p@e2e.example.com:5432/e2e',
        DB_ALLOW_REMOTE: '1', // db-migrate's opt-in: this script drops the database, so it has none
      },
    });
    expect(res.status).toBe(1);
    // the e2e URL's host, not DATABASE_URL's
    expect(res.stderr).toContain(
      '[db] refusing to recreate a non-local database (e2e.example.com)',
    );
  }, 30_000); // a cold tsx start, as above
});

describe('studio', () => {
  it('serves Drizzle Studio on this checkout’s port, not drizzle-kit’s shared default', async () => {
    const port = await closedPort();
    const studio = spawn(process.execPath, ['scripts/db-up.mjs', 'studio'], {
      cwd: DB,
      detached: true, // its own process group: drizzle-kit (a grandchild) is stopped with it
      env: { ...process.env, DB_STUDIO_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      let out = '';
      await new Promise<void>((resolve, reject) => {
        studio.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString();
          if (out.includes('is up and running')) resolve();
        });
        studio.on('exit', () => reject(new Error(`studio exited early:\n${out}`)));
      });
      expect(out).toContain(`https://local.drizzle.studio?port=${port}`);
    } finally {
      process.kill(-studio.pid!, 'SIGTERM');
    }
  }, 30_000);
});

describe('resolveDb', () => {
  // a throwaway repository with this repo's dev-ports.mjs, and a linked worktree of it
  const env = {
    PATH: process.env.PATH ?? '',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const repo = join(tmp, 'repo');
  const worktree = join(tmp, 'wt');
  beforeAll(() => {
    mkdirSync(join(repo, 'tools'), { recursive: true });
    copyFileSync(join(DB, '../../tools/dev-ports.mjs'), join(repo, 'tools/dev-ports.mjs'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
        cwd: repo,
        env,
        stdio: 'ignore',
      });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'init');
    git('worktree', 'add', '-q', '--detach', worktree);
  });

  it('names the test template per checkout, like the dev database', () => {
    expect(resolveDb(repo, env).testTemplate).toBe('test_template');
    const wt = resolveDb(worktree, env);
    expect(new URL(wt.url).pathname).toMatch(/^\/app_[0-9a-f]{8}$/);
    expect(wt.testTemplate).toBe(`test_template${new URL(wt.url).pathname.slice('/app'.length)}`);
  });

  it('names the e2e database per checkout, and never takes it from DATABASE_URL', () => {
    const remote = { ...env, DATABASE_URL: 'postgres://u:p@db.example.com:5432/app' };
    expect(resolveDb(repo, remote).e2eUrl).toBe('postgres://postgres:postgres@127.0.0.1:5432/e2e');
    const hash = new URL(resolveDb(worktree, env).url).pathname.slice('/app'.length);
    expect(new URL(resolveDb(worktree, remote).e2eUrl).pathname).toBe(`/e2e${hash}`);
    // E2E_DATABASE_URL overrides it (api:serve-e2e then serves that one too)
    const other = 'postgres://postgres:postgres@127.0.0.1:5432/other';
    expect(resolveDb(repo, { ...env, E2E_DATABASE_URL: other }).e2eUrl).toBe(other);
  });
});
