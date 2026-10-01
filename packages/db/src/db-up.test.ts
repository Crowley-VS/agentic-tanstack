// scripts/db-up.mjs without Docker: a fake `docker`, alone on PATH (or first on it), logs its
// arguments and answers `compose up` and the listings as each test scripts it, and the server's
// port is closed, so nothing ever answers.
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
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain .mjs script
import { dbUp, isLocalUrl, isOurCluster, psqlArgs, resolveDb } from '../scripts/db-up.mjs';

const DB = join(import.meta.dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'db-up-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// FAKE_DOCKER_UP: the replies to successive `compose up` calls, [{ stderr, status }] (default: ok)
// FAKE_DOCKER_LS: what `docker <kind> ls` prints, { container, volume, network } (default: nothing)
// FAKE_DOCKER_FAIL: stderr of a failure for every call (e.g. the Docker daemon is not running)
// FAKE_DOCKER_RM_FAIL: the same for removals only
// FAKE_DOCKER_ENV: a file each `compose` call appends the checkout labels' values to
const BIN = join(tmp, 'bin');
mkdirSync(BIN);
writeFileSync(
  join(tmp, 'docker.mjs'),
  `import { appendFileSync, readFileSync } from 'node:fs';
const { FAKE_DOCKER_LOG: log, FAKE_DOCKER_UP: up = '[]', FAKE_DOCKER_LS: ls = '{}' } = process.env;
const args = process.argv.slice(2);
appendFileSync(log, args.join(' ') + '\\n');
if (process.env.FAKE_DOCKER_FAIL) {
  process.stderr.write(process.env.FAKE_DOCKER_FAIL);
  process.exit(1);
}
if (process.env.FAKE_DOCKER_RM_FAIL && args.includes('rm')) {
  process.stderr.write(process.env.FAKE_DOCKER_RM_FAIL);
  process.exit(1);
}
if (args[0] === 'compose' && process.env.FAKE_DOCKER_ENV) {
  const { DEV_CHECKOUT_ROOT: root, DEV_CHECKOUT_GIT_COMMON_DIR: commonDir } = process.env;
  appendFileSync(process.env.FAKE_DOCKER_ENV, JSON.stringify({ root, commonDir }) + '\\n');
}
if (args[1] === 'ls') process.stdout.write(JSON.parse(ls)[args[0]] ?? '');
if (args.includes('up')) {
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
/**
 * The listings db-up reads before it starts a server: this repository's labeled containers and
 * volumes (leftovers of deleted checkouts?), and, when some are, everything of their projects.
 */
const LISTS = ['container ls', 'volume ls'];
const ORPHAN_LISTS = ['container ls', 'volume ls', 'network ls'];
const REPO = join(tmp, 'fake-repo', '.git'); // the fake checkout's git common dir

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
  root: tmp,
  commonDir: REPO,
});

let runs = 0;
/**
 * dbUp() against the fake docker: the message it failed with (if any) and the docker calls (a
 * listing as its first two words), and what it printed.
 */
async function run(
  cfg: ReturnType<typeof local>,
  { up = [], ls = {}, env = {} }: { up?: object[]; ls?: object; env?: Record<string, string> } = {},
) {
  const log = join(tmp, `docker-${runs++}.log`);
  const fakeEnv = {
    PATH: BIN,
    FAKE_DOCKER_LOG: log,
    FAKE_DOCKER_UP: JSON.stringify(up),
    FAKE_DOCKER_LS: JSON.stringify(ls),
    ...env,
  };
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  let error: string | undefined;
  let printed: string[] = [];
  try {
    await dbUp(cfg, { env: fakeEnv });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    printed = spy.mock.calls.map((args) => args.join(' '));
    spy.mockRestore();
  }
  const raw = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  const calls = raw.map((c) => (/^\w+ ls /.test(c) ? c.split(' ').slice(0, 2).join(' ') : c));
  return { error, calls, printed, raw };
}

describe('dbUp', () => {
  it('leaves a server that is not this checkout’s alone (no Docker call), unless DB_UP_FORCE', async () => {
    const [port, other] = [await closedPort(), await closedPort()];
    const remote = {
      ...local(port),
      url: 'postgres://u:p@db.example.com:5432/app',
      adminUrl: 'postgres://u:p@db.example.com:5432/postgres',
    };
    expect(await run(remote)).toMatchObject({ error: undefined, calls: [], printed: [] });
    // another port on this machine is another server too
    const elsewhere = { ...local(port), url: local(other).url, adminUrl: local(other).adminUrl };
    expect(await run(elsewhere)).toMatchObject({ error: undefined, calls: [], printed: [] });
    expect((await run(elsewhere, { env: { DB_UP_FORCE: '1' } })).calls).toEqual([...LISTS, UP]);
  });

  it('starts this checkout’s server even when DATABASE_URL names it (dev-ports --env exports it)', async () => {
    const cfg = local(await closedPort());
    expect((await run(cfg, { env: { DATABASE_URL: cfg.url } })).calls).toEqual([...LISTS, UP]);
    // either URL on this checkout's server is enough
    const remoteDev = { ...cfg, url: 'postgres://u:p@db.example.com:5432/app' };
    expect((await run(remoteDev)).calls).toEqual([...LISTS, UP]);
  });

  it('says so when Docker is not installed', async () => {
    const { error } = await run(local(await closedPort()), { env: { PATH: join(tmp, 'none') } });
    expect(error).toContain('Docker is not installed (no `docker` on PATH)');
  });

  it('says so when the Docker daemon is not running', async () => {
    const stderr =
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n';
    const { error, calls } = await run(local(await closedPort()), { up: [{ stderr, status: 1 }] });
    expect(calls).toEqual([...LISTS, UP]);
    expect(error).toContain('Docker is not running. Start it and retry.');
    expect(error).toContain('docker said: Cannot connect to the Docker daemon');
  });

  it('removes the half-created container when the port is taken', async () => {
    const cfg = local(await closedPort());
    const stderr = `Error response from daemon: driver failed programming external connectivity on endpoint fake-project-postgres-1: Bind for 127.0.0.1:${cfg.port} failed: port is already allocated\n`;
    const { error, calls } = await run(cfg, { up: [{ stderr, status: 1 }] });
    expect(calls).toEqual([...LISTS, UP, `${COMPOSE} down`]);
    expect(error).toContain(`Port ${cfg.port} is taken by something else.`);
  });

  it('retries `up` once when a concurrent start created the container first', async () => {
    const stderr =
      'Error response from daemon: Conflict. The container name "/fake-project-postgres-1" is already in use by container "0123abcd".\n';
    const { error, calls } = await run(local(await closedPort()), {
      up: [{ stderr, status: 1 }, {}],
    });
    expect(calls).toEqual([...LISTS, UP, UP]);
    // the retry succeeded; only the check that the port reaches the server is left
    expect(error).toMatch(/healthy but \d+ does not reach it/);
  });

  it('reports any other compose failure as is, without retrying', async () => {
    const { error, calls } = await run(local(await closedPort()), {
      up: [{ stderr: 'pull access denied\n', status: 18 }],
    });
    expect(calls).toEqual([...LISTS, UP]);
    expect(error).toContain('docker compose up failed (exit 18):\npull access denied');
  });

  it('fails when compose reports the server healthy but its port does not reach it', async () => {
    const cfg = local(await closedPort());
    const { error, calls } = await run(cfg, { up: [{}] });
    expect(calls).toEqual([...LISTS, UP]);
    expect(error).toContain(
      `compose reports fake-project healthy but ${cfg.port} does not reach it`,
    );
  });

  it('removes the leftovers of deleted checkouts before it starts the server, and says so', async () => {
    const gone = join(tmp, 'deleted-worktree');
    const cfg = local(await closedPort());
    const { error, calls, printed, raw } = await run(cfg, {
      up: [{}],
      // (the fake answers every listing with all of these, whatever its filter)
      ls: listing([
        ['container', 'cid', 'gone-proj', gone, gone],
        ['volume', 'gone-proj_pgdata', 'gone-proj', '', gone],
        ['network', 'gone-proj_default', 'gone-proj'],
        // another repository's, its checkout gone too: never ours to remove
        ['volume', 'decoy_pgdata', 'decoy', '', gone, join(tmp, 'other', '.git')],
        // this checkout's own
        ['volume', 'fake-project_pgdata', 'fake-project', '', tmp],
      ]),
    });
    expect(error).toMatch(/does not reach it/); // the fake server never answers
    // Docker picks this repository's labeled resources first, then lists the candidates' projects
    for (const call of raw.slice(0, 2))
      expect(call).toContain(` --filter label=dev-checkout.git-common-dir=${REPO} `);
    for (const call of raw.slice(2, 5))
      expect(call).toContain(' --filter label=com.docker.compose.project ');
    expect(calls).toEqual([
      ...LISTS,
      ...ORPHAN_LISTS,
      'rm --force --volumes cid',
      'network rm gone-proj_default',
      'volume rm gone-proj_pgdata',
      UP,
    ]);
    expect(printed).toEqual([
      '[db-up] removed 1 container, 1 volume, 1 network of deleted checkouts:',
      `[db-up]   gone-proj (${gone})`,
    ]);
  });

  it('still starts the server, and reports Docker’s own error, when Docker cannot list', async () => {
    const stderr =
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n';
    const { error, calls } = await run(local(await closedPort()), {
      env: { FAKE_DOCKER_FAIL: stderr },
    });
    expect(calls).toEqual(['container ls', UP]);
    expect(error).toContain('Docker is not running. Start it and retry.');
  });

  it('labels the container and volume with this repository and checkout', async () => {
    const env = join(tmp, `compose-env-${runs}.log`);
    await run(local(await closedPort()), { up: [{}], env: { FAKE_DOCKER_ENV: env } });
    expect(readFileSync(env, 'utf8')).toBe(`${JSON.stringify({ root: tmp, commonDir: REPO })}\n`);
  });

  // the compose file turns those values into labels, on the service and on the volume
  const hasCompose = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0;
  it.runIf(hasCompose)('docker-compose.yml labels the service and the volume', () => {
    const res = spawnSync(
      'docker',
      ['compose', '-f', join(DB, '../../docker-compose.yml'), 'config', '--format', 'json'],
      {
        encoding: 'utf8',
        env: { ...process.env, DEV_CHECKOUT_ROOT: '/r', DEV_CHECKOUT_GIT_COMMON_DIR: '/r/.git' },
      },
    );
    expect(res.status, res.stderr).toBe(0);
    const config = JSON.parse(res.stdout);
    const labels = { 'dev-checkout.root': '/r', 'dev-checkout.git-common-dir': '/r/.git' };
    expect(config.services.postgres.labels).toMatchObject(labels);
    expect(config.volumes.pgdata.labels).toMatchObject(labels);
  });

  // the fast path: this checkout's own server answers, so Docker is never asked (not even to prune)
  const url = process.env.TEST_FILE_DATABASE_URL ?? '';
  const onComposeServer = isLocalUrl(url) && Number(new URL(url).port) === resolveDb().port;
  it.runIf(onComposeServer)('calls no Docker at all while the server answers', async () => {
    const { error, calls } = await run(resolveDb());
    expect({ error, calls }).toEqual({ error: undefined, calls: [] });
  });
});

/**
 * FAKE_DOCKER_LS for `docker <kind> ls`: [kind, id, project, workingDir, root, commonDir = REPO]
 * per resource, as orphans.mjs formats them (id, then its LABELS' values).
 */
function listing(rows: string[][]) {
  const ls: Record<string, string> = {};
  for (const [kind = '', id, project, workingDir = '', root = '', commonDir = REPO] of rows) {
    const labels =
      kind === 'network' ? ['', '', project, ''] : [commonDir, root, project, workingDir];
    ls[kind] = `${ls[kind] ?? ''}${[id, ...labels].map((v) => JSON.stringify(v)).join('\t')}\n`;
  }
  return ls;
}

/** db-up.mjs `mode` in this checkout, with the fake docker first on PATH. */
function cli(mode: string, env: Record<string, string> = {}) {
  const log = join(tmp, `docker-${runs++}.log`);
  const res = spawnSync(process.execPath, ['scripts/db-up.mjs', mode], {
    cwd: DB,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${BIN}${delimiter}${process.env.PATH}`,
      FAKE_DOCKER_LOG: log,
      ...env,
    },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  return { ...res, calls };
}

describe('down and prune', () => {
  const notRunning =
    'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n';

  it('down stops this checkout’s server, keeps its volume, and is done when Docker is not running', () => {
    const { project, composeFile } = resolveDb();
    const ok = cli('down');
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.calls).toEqual([`compose -p ${project} -f ${composeFile} down`]); // no -v
    const off = cli('down', { FAKE_DOCKER_FAIL: notRunning });
    expect(off.status, off.stderr).toBe(0);
    expect(off.stdout).toContain(`[db-up] Docker is not running: nothing to stop for ${project}`);
    // any other failure is one, a Docker that runs but refuses this user included
    const denied =
      'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n';
    const failed = cli('down', { FAKE_DOCKER_FAIL: denied });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('permission denied');
  }, 30_000);

  it('prune removes this repository’s leftovers and prints them, or says there were none', () => {
    const { commonDir } = resolveDb();
    const gone = join(tmp, 'deleted-worktree');
    const ls = listing([['volume', 'gone-proj_pgdata', 'gone-proj', '', gone, commonDir]]);
    const res = cli('prune', { FAKE_DOCKER_LS: JSON.stringify(ls) });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toBe(
      `[db-up] removed 1 volume of deleted checkouts:\n[db-up]   gone-proj (${gone})\n`,
    );
    expect(res.calls.at(-1)).toBe('volume rm gone-proj_pgdata');
    expect(cli('prune').stdout).toBe('[db-up] no leftovers of deleted checkouts\n');
    const off = cli('prune', { FAKE_DOCKER_FAIL: notRunning });
    expect(off.status, off.stderr).toBe(0);
    expect(off.stdout).toContain('Cannot connect to the Docker daemon');
    expect(off.stdout).toContain(': no containers or volumes to prune');
  }, 30_000);

  it('prune counts what another prune removed first as removed, and reports a real refusal', () => {
    const { commonDir } = resolveDb();
    const gone = join(tmp, 'deleted-worktree');
    const ls = JSON.stringify(
      listing([['volume', 'gone-proj_pgdata', 'gone-proj', '', gone, commonDir]]),
    );
    const raced = cli('prune', {
      FAKE_DOCKER_LS: ls,
      FAKE_DOCKER_RM_FAIL: 'Error response from daemon: get gone-proj_pgdata: no such volume\n',
    });
    expect(raced.status, raced.stderr).toBe(0);
    expect(raced.stderr).toBe('');
    const refused = cli('prune', {
      FAKE_DOCKER_LS: ls,
      FAKE_DOCKER_RM_FAIL:
        'Error response from daemon: remove gone-proj_pgdata: volume is in use - [0123abcd]\n',
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toBe(
      '[db-up] could not prune: docker volume rm: Error response from daemon: remove gone-proj_pgdata: volume is in use - [0123abcd]\n',
    );
  }, 30_000);
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

describe('psql', () => {
  it('allocates a terminal only when stdin is one, and passes its arguments on to psql', () => {
    const psql = ['postgres', 'psql', '-U', 'postgres', '-d', 'app', '-c', 'select 1'];
    expect(psqlArgs('app', ['-c', 'select 1'], { tty: true })).toEqual(['exec', ...psql]);
    expect(psqlArgs('app', ['-c', 'select 1'], { tty: false })).toEqual(['exec', '-T', ...psql]);
  });

  // what `pnpm nx run db:db-psql -- -c "select …"` runs, in a shell with no terminal (an agent's)
  const url = process.env.TEST_FILE_DATABASE_URL ?? '';
  const onComposeServer = isLocalUrl(url) && Number(new URL(url).port) === resolveDb().port;
  it.runIf(onComposeServer)(
    'runs a query without a terminal and prints its result',
    () => {
      const res = spawnSync(
        process.execPath,
        ['scripts/db-up.mjs', 'psql', '-tA', '-c', 'select current_database()'],
        {
          cwd: DB,
          encoding: 'utf8',
          env: { ...process.env, DATABASE_URL: url }, // this test file's own database
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      expect(res.stdout, res.stderr).toBe(`${new URL(url).pathname.slice(1)}\n`);
      expect(res.status).toBe(0);
    },
    30_000,
  );
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
