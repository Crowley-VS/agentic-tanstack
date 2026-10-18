// scripts/db-up.mjs, mostly without Docker: a fake `docker`, alone on PATH (or first on it), logs
// its arguments and answers `compose up` and the listings as each test scripts it. The server's
// port is closed by default, so nothing answers; where a test needs a server, fakePostgres answers
// on it once the fake `up` has created the container (fakeServer). The blocks that run only where
// Docker runs (describe.runIf(dockerRuns), it.runIf(hasCompose)) use the real one.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { type AddressInfo, createServer, type Socket } from 'node:net';
import { devNull, hostname, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  alive,
  cleanLocks,
  dbUp,
  isLocalUrl,
  isOurCluster,
  psqlArgs,
  resolveDb,
  takeOver,
  // @ts-expect-error plain .mjs script
} from '../scripts/db-up.mjs';
// @ts-expect-error plain .mjs script
import { LABELS } from '../scripts/orphans.mjs';

const DB = join(import.meta.dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'db-up-test-'));

/**
 * The reaper: removes what this file started even when its process ends without running its
 * hooks (Vitest exits on SIGINT and SIGTERM without them and kills a worker that does not stop;
 * Nx kills a task's whole process tree). It runs outside this process's tree (started by a process
 * that exits at once) and in a session of its own (a terminal's Ctrl-C does not reach it), and
 * checks every 100 ms that process REAP_PID still runs. Once that one has exited, it kills the
 * process groups and removes the compose projects (with their volumes) that REAP_LIST still
 * names (one JSON line per change), then REAP_DIR. Once REAP_DIR is gone (the hooks ran), it exits.
 */
const REAPER = `const { spawn, spawnSync } = require('node:child_process');
const { existsSync, readFileSync, rmSync } = require('node:fs');
const { REAPER, REAP_DIR: dir, REAP_LIST: list, REAP_PID: pid } = process.env;
if (!process.env.REAPING) {
  const env = { ...process.env, REAPING: '1' };
  spawn(process.execPath, ['-e', REAPER], { detached: true, stdio: 'ignore', env }).unref();
} else {
  const running = () => {
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  };
  const timer = setInterval(() => {
    if (!existsSync(dir)) process.exit();
    if (running()) return;
    clearInterval(timer);
    const groups = new Set();
    const projects = new Map();
    let lines = [];
    try {
      lines = readFileSync(list, 'utf8').split('\\n');
    } catch {}
    for (const line of lines) {
      let change = {};
      try {
        change = JSON.parse(line);
      } catch {}
      if (change.group) groups.add(change.group);
      if (change.ungroup) groups.delete(change.ungroup);
      if (change.project) projects.set(change.project.name, change.project);
      if (change.unproject) projects.delete(change.unproject);
    }
    for (const group of groups) {
      try {
        process.kill(-group, 'SIGKILL');
      } catch {}
    }
    for (const { name, composeFile, port } of projects.values())
      spawnSync('docker', ['compose', '-p', name, '-f', composeFile, 'down', '-v', '-t', '0'], {
        env: { ...process.env, DB_PORT: String(port), COMPOSE_PROJECT_NAME: name },
        stdio: 'ignore',
      });
    rmSync(dir, { recursive: true, force: true });
  }, 100);
}
`;

/** Start a reaper (REAPER) of `dir` that watches this process; returns `reap(change)`. */
function reaper(dir: string) {
  const list = join(dir, 'reaper.jsonl');
  const env = { REAPER, REAP_DIR: dir, REAP_LIST: list, REAP_PID: String(process.pid) };
  spawn(process.execPath, ['-e', REAPER], {
    detached: true,
    env: { ...process.env, ...env },
    stdio: 'ignore',
  }).unref();
  return (change: object) => {
    try {
      appendFileSync(list, `${JSON.stringify(change)}\n`);
    } catch {
      // `dir` is gone: the hooks ran, nothing is left to reap
    }
  };
}

// this file's own: its temp directory, the processes it starts, its projects on Docker
const reap = reaper(tmp);
afterAll(() => rmSync(tmp, { recursive: true, force: true })); // (then the reaper exits)

// FAKE_DOCKER_UP: the replies to successive `compose up` calls, [{ stderr, status }] (default: ok)
// FAKE_DOCKER_LS: what `docker <kind> ls` prints, { container, volume, network, image }, and
//   `docker image inspect`, { inspect } (default: nothing)
// FAKE_DOCKER_FAIL: stderr of a failure for every call (e.g. the Docker daemon is not running)
// FAKE_DOCKER_RM_FAIL: the same for removals only
// FAKE_DOCKER_GONE: `docker <kind> inspect` finds nothing (default: it finds what it is asked for)
// FAKE_DOCKER_ENV: a file each `compose` call appends the checkout labels' values to
// FAKE_DOCKER_STATE: a file standing for the container, which an `up` that succeeds creates as
//   Docker does: in FAKE_DOCKER_CREATE_MS (default 300), during which another `up` fails on the
//   container name, as a concurrent compose does; once it exists, an `up` finds it (fakePostgres
//   answers while it exists)
// FAKE_DOCKER_TAKEOVER: a lock file each `up` overwrites with another process's lock, as a waiter
//   that takes it over while the start runs does
const BIN = join(tmp, 'bin');
mkdirSync(BIN);
writeFileSync(
  join(tmp, 'docker.mjs'),
  `import { appendFileSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
if (args[1] === 'inspect' && process.env.FAKE_DOCKER_GONE) {
  process.stderr.write('Error: No such object: ' + args[2] + '\\n');
  process.exit(1);
}
if (args[0] === 'image' && args[1] === 'inspect') process.stdout.write(JSON.parse(ls).inspect ?? '[]');
if (args.includes('up') && process.env.FAKE_DOCKER_TAKEOVER)
  writeFileSync(process.env.FAKE_DOCKER_TAKEOVER, JSON.stringify({ pid: 1, project: 'fake-project', token: 'theirs' }));
if (args.includes('up')) {
  const n = readFileSync(log, 'utf8').split('\\n').filter((l) => l.split(' ').includes('up')).length;
  const { stderr = '', status = 0 } = JSON.parse(up)[n - 1] ?? {};
  process.stderr.write(stderr);
  const state = process.env.FAKE_DOCKER_STATE;
  if (status !== 0 || !state || existsSync(state)) process.exit(status);
  try {
    openSync(state + '.creating', 'wx');
  } catch {
    process.stderr.write('Error response from daemon: Conflict. The container name "/fake-project-postgres-1" is already in use by container "0123abcd". You have to remove (or rename) that container to be able to reuse that name.\\n');
    process.exit(1);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_DOCKER_CREATE_MS ?? 300));
  writeFileSync(state, '');
  unlinkSync(state + '.creating');
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
 * The listings db-up reads before it starts a server: this repository's labeled containers,
 * volumes and images (leftovers of deleted checkouts?), and, when some are, everything of their
 * projects.
 */
const LISTS = ['container ls', 'volume ls', 'image ls'];
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
  ownsProject: true,
});

// Postgres protocol pieces: a 2- or 4-byte integer, a C string, a message (type, length, body)
const int = (size: 2 | 4, n: number) => {
  const b = Buffer.alloc(size);
  if (size === 2) b.writeInt16BE(n);
  else b.writeInt32BE(n);
  return b;
};
const cstring = (s: string) => Buffer.from(`${s}\0`);
const msg = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from(type), int(4, body.length + 4), body]);
};

/**
 * A Postgres on `port` that, while `up()` is true, answers db-up's `show cluster_name` with
 * `project` (the protocol's startup, a simple query and its reply, nothing else), and otherwise
 * drops every connection, as a server that is still starting does. Resolves to its stop function.
 */
async function fakePostgres(port: number, project: string, up: () => boolean) {
  const ready = msg('Z', Buffer.from('I'));
  const reply = Buffer.concat([
    // one text column (no table, type oid 25, variable length, no modifier, text format), then
    // its row, then the command's end
    msg(
      'T',
      int(2, 1),
      cstring('cluster_name'),
      int(4, 0),
      int(2, 0),
      int(4, 25),
      int(2, -1),
      int(4, -1),
      int(2, 0),
    ),
    msg('D', int(2, 1), int(4, Buffer.byteLength(project)), Buffer.from(project)),
    msg('C', cstring('SHOW')),
    ready,
  ]);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    if (!up()) {
      socket.destroy();
      return;
    }
    let started = false;
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        // the startup message has no type byte; every later one has
        const at = started ? 1 : 0;
        if (buf.length < at + 4 || buf.length < at + buf.readInt32BE(at)) return;
        const type = started ? String.fromCharCode(buf[0] ?? 0) : '';
        buf = buf.subarray(at + buf.readInt32BE(at));
        if (!started) socket.write(Buffer.concat([msg('R', int(4, 0)), ready])); // trust
        else if (type === 'Q') socket.write(reply);
        else if (type === 'X') socket.end();
        started = true;
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  };
}

let runs = 0;
/** A directory of its own for one test's locks: no other test or checkout ever shares it. */
const lockDir = () => mkdtempSync(join(tmp, 'locks-'));
/** dbUp's timings for the tests: no real waits. */
const fast = { pollMs: 20, backoffMs: 1, noticeMs: 60_000, staleMs: 60_000 };

/**
 * dbUp() against the fake docker: the message it failed with (if any) and the docker calls (a
 * listing as its first two words), and what it printed, on stdout and on stderr.
 */
async function run(
  cfg: ReturnType<typeof local>,
  {
    up = [],
    ls = {},
    env = {},
    options = {},
  }: { up?: object[]; ls?: object; env?: Record<string, string>; options?: object } = {},
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
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  let error: string | undefined;
  let printed: string[] = [];
  let warned: string[] = [];
  try {
    await dbUp(cfg, { env: fakeEnv, lockDir: lockDir(), ...fast, ...options });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    printed = spy.mock.calls.map((args) => args.join(' '));
    warned = errSpy.mock.calls.map((args) => args.join(' '));
    spy.mockRestore();
    errSpy.mockRestore();
  }
  const raw = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  const calls = raw.map((c) => (/^\w+ ls /.test(c) ? c.split(' ').slice(0, 2).join(' ') : c));
  return { error, calls, printed, warned, raw };
}

/** The process groups of dbUpProcesses' children that still run. */
const children = new Set<number>();
/**
 * Kill them, and the `docker compose` each may run: one a test leaves behind (it failed, or timed
 * out) would go on to start a server no one removes. (When this process ends without its hooks,
 * the reaper kills them.)
 */
function killChildren() {
  for (const pid of children) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // exited meanwhile
    }
    children.delete(pid);
    reap({ ungroup: pid });
  }
}
afterEach(killChildren);

/**
 * dbUp() in `n` processes at once, as Nx runs the tests of several db-using projects, each with
 * the cfg and options `argsFor(i)` gives it (and `env` added to this process's): each one's exit
 * code and stderr. Each runs in a process group of its own, which killChildren (or the reaper)
 * kills.
 */
function dbUpProcesses(n: number, argsFor: (i: number) => object, env: object = {}) {
  const code = `import { dbUp } from ${JSON.stringify(join(DB, 'scripts/db-up.mjs'))};
const { cfg, ...options } = JSON.parse(process.env.DB_UP_ARGS);
await dbUp(cfg, options);`;
  return Promise.all(
    Array.from({ length: n }, (_, i) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        cwd: DB,
        detached: true,
        env: { ...process.env, ...env, DB_UP_ARGS: JSON.stringify(argsFor(i)) },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      if (child.pid) {
        children.add(child.pid);
        reap({ group: child.pid });
      }
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      return new Promise<{ status: number | null; stderr: string }>((resolve) =>
        child.on('close', (status) => {
          if (child.pid) {
            children.delete(child.pid);
            reap({ ungroup: child.pid });
          }
          resolve({ status, stderr });
        }),
      );
    }),
  );
}

/** The `compose up` calls a docker log holds. */
const ups = (log: string) =>
  readFileSync(log, 'utf8')
    .split('\n')
    .filter((call) => call.endsWith(' up -d --wait'));

// what Docker Hub answered CI's runners (actions runs 37994128478 and 37994452070)
const transient = [
  'Error response from daemon: Head "https://registry-1.docker.io/v2/library/postgres/manifests/18.6-trixie": Get "https://auth.docker.io/token?account=githubactions&scope=repository%3Alibrary%2Fpostgres%3Apull&service=registry.docker.io": context deadline exceeded (Client.Timeout exceeded while awaiting headers)',
  'Error response from daemon: Head "https://registry-1.docker.io/v2/library/postgres/manifests/18.6-trixie": Get "https://auth.docker.io/token?account=githubactions&scope=repository%3Alibrary%2Fpostgres%3Apull&service=registry.docker.io": net/http: request canceled (Client.Timeout exceeded while awaiting headers)',
  'Error response from daemon: toomanyrequests: You have reached your unauthenticated pull rate limit. https://www.docker.com/increase-rate-limit',
  'Error response from daemon: Get "https://registry-1.docker.io/v2/": net/http: TLS handshake timeout',
  'Error response from daemon: Get "https://registry-1.docker.io/v2/": dial tcp 54.236.113.205:443: i/o timeout',
  'failed to fetch oauth token: unexpected status from POST request to https://auth.docker.io/token: 504 Gateway Timeout',
  'Error response from daemon: Get "https://registry-1.docker.io/v2/": read tcp 10.1.0.4:39912->54.236.113.205:443: read: connection reset by peer',
];
// what a real `docker compose up` prints on every run once the volume exists but compose did not
// create it (`docker volume create`): a warning, not a failure
const volumeWarning =
  'time="2026-10-11T14:20:32-04:00" level=warning msg="volume \\"fake-project_pgdata\\" already exists but was not created by Docker Compose. Use `external: true` to use an existing volume"';

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
    // a daemon whose socket times out is not running either: no retry of the timeout
    const timedOut =
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock: dial unix /var/run/docker.sock: i/o timeout\n';
    const again = await run(local(await closedPort()), { up: [{ stderr: timedOut, status: 1 }] });
    expect(again.calls).toEqual([...LISTS, UP]);
    expect(again.error).toContain('Docker is not running. Start it and retry.');
  });

  it('removes the half-created container when the port is taken', async () => {
    const cfg = local(await closedPort());
    const stderr = `Error response from daemon: driver failed programming external connectivity on endpoint fake-project-postgres-1: Bind for 127.0.0.1:${cfg.port} failed: port is already allocated\n`;
    const { error, calls } = await run(cfg, { up: [{ stderr, status: 1 }] });
    expect(calls).toEqual([...LISTS, UP, `${COMPOSE} down`]);
    expect(error).toContain(`Port ${cfg.port} is taken by something else.`);
  });

  it('retries `up`, after a wait, when a start outside the lock created the container first', async () => {
    const stderr =
      'Error response from daemon: Conflict. The container name "/fake-project-postgres-1" is already in use by container "0123abcd".\n';
    const { error, calls, warned } = await run(local(await closedPort()), {
      up: [{ stderr, status: 1 }, {}],
    });
    expect(calls).toEqual([...LISTS, UP, UP]);
    expect(warned).toEqual([
      '[db-up] docker compose up failed (another start created its container first): try 2 of 4 in 0.001 s',
    ]);
    // the retry succeeded; only the check that the port reaches the server is left
    expect(error).toMatch(/healthy but \d+ does not reach it/);
  });

  it('retries a pull or start that failed on a network or registry error, then starts the server', async () => {
    const port = await closedPort();
    const state = join(tmp, `container-${runs}`);
    const stop = await fakePostgres(port, 'fake-project', () => existsSync(state));
    try {
      const { error, calls, warned } = await run(local(port), {
        up: [
          { stderr: `${transient[0]}\n`, status: 1 },
          { stderr: `${transient[2]}\n`, status: 1 },
          {},
        ],
        env: { FAKE_DOCKER_STATE: state, FAKE_DOCKER_CREATE_MS: '0' },
        options: { backoffMs: 10 },
      });
      expect(error).toBeUndefined();
      expect(calls).toEqual([...LISTS, UP, UP, UP]);
      // a growing wait between the tries
      expect(warned).toEqual([
        '[db-up] docker compose up failed (context deadline exceeded): try 2 of 4 in 0.01 s',
        '[db-up] docker compose up failed (toomanyrequests): try 3 of 4 in 0.02 s',
      ]);
    } finally {
      await stop();
    }
  });

  it('retries each kind of transient error, and reports it once its tries are used up', async () => {
    for (const stderr of transient) {
      const { calls } = await run(local(await closedPort()), { up: [{ stderr, status: 1 }, {}] });
      expect(calls, stderr).toEqual([...LISTS, UP, UP]);
    }
    const failing = Array.from({ length: 4 }, () => ({ stderr: `${transient[1]}\n`, status: 1 }));
    const { error, calls } = await run(local(await closedPort()), { up: failing });
    expect(calls).toEqual([...LISTS, UP, UP, UP, UP]);
    expect(error).toContain(`docker compose up failed (exit 1):\n${transient[1]}`);
  });

  it('reports any other compose failure as is, without retrying', async () => {
    for (const stderr of [
      "Error response from daemon: pull access denied for postgres, repository does not exist or may require 'docker login'\n",
      'Error response from daemon: manifest for postgres:18.6-trixie not found: manifest unknown\n',
      'dependency failed to start: container fake-project-postgres-1 is unhealthy\n',
    ]) {
      const { error, calls, warned } = await run(local(await closedPort()), {
        up: [{ stderr, status: 18 }],
      });
      expect(calls).toEqual([...LISTS, UP]);
      expect(warned).toEqual([]);
      expect(error).toBe(`[db-up] docker compose up failed (exit 18):\n${stderr}`);
    }
  });

  it('takes compose’s warning about a volume it did not create for no race', async () => {
    // an unhealthy start, after that warning: reported at once
    const unhealthy = `${volumeWarning}\ndependency failed to start: container fake-project-postgres-1 is unhealthy\n`;
    const once = await run(local(await closedPort()), { up: [{ stderr: unhealthy, status: 1 }] });
    expect(once.calls).toEqual([...LISTS, UP]);
    expect(once.warned).toEqual([]);
    expect(once.error).toBe(`[db-up] docker compose up failed (exit 1):\n${unhealthy}`);
    // after the same warning, a start outside the lock that created the container, or its
    // network, first is still retried
    for (const conflict of [
      'Error response from daemon: Conflict. The container name "/fake-project-postgres-1" is already in use by container "0123abcd".',
      'Error response from daemon: network with name fake-project_default already exists',
    ]) {
      const { calls, warned } = await run(local(await closedPort()), {
        up: [{ stderr: `${volumeWarning}\n${conflict}\n`, status: 1 }, {}],
      });
      expect(calls, conflict).toEqual([...LISTS, UP, UP]);
      expect(warned[0], conflict).toContain('(another start created its container first)');
    }
  });

  it('starts without its lock, saying so, where its lock directory is unusable', async () => {
    const dirs: [string, string][] = [[join(tmp, 'no-such-dir', 'locks'), 'ENOENT']];
    const link = join(tmp, `locks-link-${runs}`);
    symlinkSync(lockDir(), link);
    dirs.push([link, 'not a directory only this user can write to']);
    if (process.getuid) {
      // a directory other users can write to: any of them could leave a lock there
      const open = lockDir();
      chmodSync(open, 0o777);
      dirs.push([open, 'not a directory only this user can write to']);
    }
    for (const [dir, why] of dirs) {
      const { error, calls, warned } = await run(local(await closedPort()), {
        up: [{}],
        options: { lockDir: dir },
      });
      expect(warned, dir).toEqual([
        `[db-up] starting fake-project without its lock (${dir}: ${why})`,
      ]);
      expect(calls, dir).toEqual([...LISTS, UP]);
      expect(error, dir).toMatch(/does not reach it/); // (the fake server never answers)
    }
  });

  // a FIFO where the lock should be: reading it the usual way would block forever
  const hasMkfifo = spawnSync('sh', ['-c', 'command -v mkfifo'], { stdio: 'ignore' }).status === 0;
  it.runIf(hasMkfifo)(
    'starts without its lock, never blocked, when the lock is no regular file',
    async () => {
      const dir = lockDir();
      const file = join(dir, 'db-up-fake-project.lock');
      execFileSync('mkfifo', [file]);
      const { calls, warned } = await run(local(await closedPort()), {
        up: [{}],
        options: { lockDir: dir },
      });
      expect(warned).toEqual([
        `[db-up] starting fake-project without its lock (${file}: not a regular file)`,
      ]);
      expect(calls).toEqual([...LISTS, UP]);
    },
  );

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
    for (const call of raw.slice(0, 3))
      expect(call).toMatch(new RegExp(` --filter label=dev-checkout.git-common-dir=${REPO}( |$)`));
    for (const call of raw.slice(3, 6))
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

  it('labels nothing as this checkout’s in a project COMPOSE_PROJECT_NAME names (it may be shared)', async () => {
    const env = join(tmp, `compose-env-${runs}.log`);
    const shared = { ...local(await closedPort()), ownsProject: false };
    await run(shared, { up: [{}], env: { FAKE_DOCKER_ENV: env } });
    // empty labels: `prune` never removes it, whichever checkout created it is deleted
    expect(readFileSync(env, 'utf8')).toBe(`${JSON.stringify({ root: '', commonDir: '' })}\n`);
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

/** A fake server on a free port, which answers once the fake docker's `up` has created it. */
async function fakeServer() {
  const port = await closedPort();
  const state = join(tmp, `container-${runs++}`);
  const stop = await fakePostgres(port, 'fake-project', () => existsSync(state));
  const env = { PATH: BIN, FAKE_DOCKER_STATE: state };
  return { cfg: local(port), env, state, stop };
}

/** A start lock of fake-project in a fresh directory, held by process `pid`. */
function heldLock(pid: number) {
  const dir = lockDir();
  const file = join(dir, 'db-up-fake-project.lock');
  writeFileSync(file, JSON.stringify({ pid, project: 'fake-project', token: 'theirs' }));
  return { dir, file };
}

// On a push to main, `nx affected` runs the tests of api, core and db at once on a fresh runner,
// and each one's global setup starts the same server: they raced to create its container, and a
// retry that lost again failed the run (actions run 38073767504).
describe('dbUp in several processes at once', () => {
  it('runs `compose up` once, and every process gets the server', async () => {
    const { cfg, env, stop } = await fakeServer();
    const log = join(tmp, `docker-${runs++}.log`);
    const locks = lockDir();
    try {
      const results = await dbUpProcesses(3, () => ({
        cfg,
        env: { ...env, FAKE_DOCKER_LOG: log },
        lockDir: locks,
        ...fast,
      }));
      expect(results).toEqual(Array.from({ length: 3 }, () => ({ status: 0, stderr: '' })));
      expect(ups(log)).toHaveLength(1);
      expect(readdirSync(locks)).toEqual([]); // released
    } finally {
      await stop();
    }
  }, 30_000);

  it('without a lock they share, each loser retries until the container exists', async () => {
    const { cfg, env, stop } = await fakeServer();
    const log = join(tmp, `docker-${runs++}.log`);
    try {
      // a container that takes a while to create, as on CI's loaded runner, where the old
      // immediate retry failed on its name again; the retries wait 0.3 + 0.6 + 1.2 s, longer
      const results = await dbUpProcesses(3, () => ({
        cfg,
        env: { ...env, FAKE_DOCKER_LOG: log, FAKE_DOCKER_CREATE_MS: '1000' },
        lockDir: lockDir(),
        ...fast,
        backoffMs: 300,
      }));
      expect(results.map((r) => r.status)).toEqual([0, 0, 0]);
      // (all three start within the second the first one's creation takes, unless the machine
      // is very busy: then fewer lose)
      const losers = results.filter((r) => r.stderr.includes('(another start created'));
      expect(losers.length).toBeGreaterThanOrEqual(1);
      expect(ups(log).length).toBeGreaterThan(3);
    } finally {
      await stop();
    }
  }, 30_000);

  it('takes over the lock of a process that has exited, at once', async () => {
    const { cfg, env, stop } = await fakeServer();
    const gone = spawnSync(process.execPath, ['-e', '']).pid ?? 0;
    expect(gone).toBeGreaterThan(0);
    const lock = heldLock(gone);
    try {
      // noticeMs 0: a single wait would print its notice
      const options = { lockDir: lock.dir, noticeMs: 0 };
      const { error, calls, warned } = await run(cfg, { env, options });
      expect({ error, warned }).toEqual({ error: undefined, warned: [] });
      expect(calls).toEqual([...LISTS, UP]);
      expect(existsSync(lock.file)).toBe(false); // released
    } finally {
      await stop();
    }
  }, 30_000);

  it('takes over a lock older than staleMs, whatever its process', async () => {
    const { cfg, env, stop } = await fakeServer();
    // a live process (this one), as when the holder's pid was reused or its start hangs
    const lock = heldLock(process.pid);
    const old = new Date(Date.now() - fast.staleMs - 1000);
    utimesSync(lock.file, old, old);
    try {
      const options = { lockDir: lock.dir, noticeMs: 0 };
      const { error, calls, warned } = await run(cfg, { env, options });
      // at once (no notice of a wait), saying so
      expect(error).toBeUndefined();
      expect(warned).toEqual([
        expect.stringMatching(
          new RegExp(
            `^\\[db-up\\] taking over \\S+ from pid ${process.pid} after 6\\d s: its start of fake-project takes too long$`,
          ),
        ),
      ]);
      expect(calls).toEqual([...LISTS, UP]);
    } finally {
      await stop();
    }
  }, 30_000);

  it('waits for a live holder, and returns once the server answers, without calling Docker', async () => {
    const { cfg, env, state, stop } = await fakeServer();
    const lock = heldLock(process.pid);
    // the holder's server answers a moment later
    const started = setTimeout(() => writeFileSync(state, ''), 300);
    try {
      const { error, calls } = await run(cfg, { env, options: { lockDir: lock.dir } });
      expect({ error, calls }).toEqual({ error: undefined, calls: [] });
      expect(existsSync(lock.file)).toBe(true); // the holder's, left to it
    } finally {
      clearTimeout(started);
      await stop();
    }
  }, 30_000);

  it('says what it waits for, and waits on a lock no longer than staleMs', async () => {
    const { cfg, env, stop } = await fakeServer();
    // a live holder whose start hangs: its server never answers
    const lock = heldLock(process.pid);
    try {
      const t0 = Date.now();
      const options = { lockDir: lock.dir, noticeMs: 100, staleMs: 1000 };
      const { error, calls, warned } = await run(cfg, { env, options });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
      expect(warned[0]).toMatch(
        new RegExp(
          `^\\[db-up\\] waiting for another db-up \\(pid ${process.pid}\\) to start fake-project: \\d+ s so far\\. `,
        ),
      );
      // (the lock is as old as this wait: it was taken a moment before)
      expect(warned[0]).toContain(
        `Its lock ${lock.file} is taken over once that process exits, or once it is 1 s old (now 0 s).`,
      );
      // then it took the lock over and started the server itself
      expect(warned.at(-1)).toMatch(
        new RegExp(`^\\[db-up\\] taking over \\S+ from pid ${process.pid} after 1 s: `),
      );
      expect({ error, calls }).toEqual({ error: undefined, calls: [...LISTS, UP] });
    } finally {
      await stop();
    }
  }, 30_000);

  // Behind a hung start, then behind the start of the waiter that took it over: the whole wait is
  // past staleMs, the current lock is not, and the notice tells them apart.
  it('says how long it has waited in all, and how old the lock it waits on now is', async () => {
    const { cfg, env, stop } = await fakeServer();
    const lock = heldLock(process.pid);
    // 2 s on, another process's lock is in its place (a new start's)
    const next = setTimeout(() => {
      writeFileSync(`${lock.file}.next`, JSON.stringify({ pid: process.pid, token: 'next' }));
      renameSync(`${lock.file}.next`, lock.file);
    }, 2000);
    try {
      const options = { lockDir: lock.dir, noticeMs: 3500, staleMs: 3000 };
      const { error, calls, warned } = await run(cfg, { env, options });
      expect({ error, calls }).toEqual({ error: undefined, calls: [...LISTS, UP] });
      const notice = new RegExp(
        `^\\[db-up\\] waiting for another db-up \\(pid ${process.pid}\\) to start fake-project: (\\d+) s so far\\. Its lock \\S+ is taken over once that process exits, or once it is 3 s old \\(now (\\d+) s\\)\\.$`,
      ).exec(warned[0] ?? '');
      expect(notice, warned[0]).not.toBeNull();
      const [total, age] = [Number(notice?.[1]), Number(notice?.[2])];
      expect(total).toBeGreaterThan(3); // past staleMs in all
      expect(age).toBeLessThan(3); // not on this lock
      // which it took over once that lock was 3 s old
      expect(warned.at(-1)).toMatch(/^\[db-up\] taking over \S+ from pid \d+ after 3 s: /);
    } finally {
      clearTimeout(next);
      await stop();
    }
  }, 30_000);

  // A start that hangs past staleMs: every waiter gives up on it at about the same moment. One of
  // them takes its lock over; the others then wait on that new lock, which they judge on its own
  // (they took each other's over at once before, and all ran `compose up`).
  it('past staleMs, one waiter takes the hung start’s lock over, and none another waiter’s', async () => {
    const { cfg, env, stop } = await fakeServer();
    const log = join(tmp, `docker-${runs++}.log`);
    const lock = heldLock(process.pid); // a live holder whose server never answers
    try {
      const results = await dbUpProcesses(3, () => ({
        cfg,
        env: { ...env, FAKE_DOCKER_LOG: log },
        lockDir: lock.dir,
        ...fast,
        staleMs: 2000,
      }));
      expect(results.map((r) => r.status)).toEqual([0, 0, 0]);
      expect(ups(log)).toHaveLength(1);
      const takeovers = results.flatMap(({ stderr }) =>
        stderr.split('\n').filter((line) => line.includes('taking over')),
      );
      expect(takeovers).toEqual([
        expect.stringMatching(new RegExp(` from pid ${process.pid} after 2 s: `)),
      ]);
      expect(readdirSync(lock.dir)).toEqual([]);
    } finally {
      await stop();
    }
  }, 30_000);

  it('of several processes that find a dead start’s lock, one takes it over, leaving nothing', async () => {
    const { cfg, env, stop } = await fakeServer();
    const log = join(tmp, `docker-${runs++}.log`);
    const lock = heldLock(spawnSync(process.execPath, ['-e', '']).pid ?? 0);
    try {
      const results = await dbUpProcesses(4, () => ({
        cfg,
        env: { ...env, FAKE_DOCKER_LOG: log },
        lockDir: lock.dir,
        ...fast,
      }));
      expect(results).toEqual(Array.from({ length: 4 }, () => ({ status: 0, stderr: '' })));
      expect(ups(log)).toHaveLength(1);
      expect(readdirSync(lock.dir)).toEqual([]); // no lock, and none moved aside
    } finally {
      await stop();
    }
  }, 30_000);

  // A registry that keeps failing: the holder's tries all fail. Each waiter used to take the lock
  // in turn and try as often again (3 processes: 12 pulls, the last failing after 42 s).
  it('fails the processes that waited for a start that failed, without tries of their own', async () => {
    const { cfg, env, stop } = await fakeServer();
    const log = join(tmp, `docker-${runs++}.log`);
    const locks = lockDir();
    const refused = Array.from({ length: 12 }, () => ({ stderr: `${transient[2]}\n`, status: 1 }));
    try {
      // the holder's 4 tries, 0.1, 0.2 and 0.4 s apart: the others are waiting by then
      const results = await dbUpProcesses(3, () => ({
        cfg,
        env: { ...env, FAKE_DOCKER_LOG: log, FAKE_DOCKER_UP: JSON.stringify(refused) },
        lockDir: locks,
        ...fast,
        backoffMs: 100,
      }));
      expect(results.map((r) => r.status)).toEqual([1, 1, 1]);
      expect(ups(log)).toHaveLength(4);
      for (const { stderr } of results)
        expect(stderr).toContain(`docker compose up failed (exit 1):\n${transient[2]}`);
      const waiters = results.filter(({ stderr }) =>
        /another db-up \(pid \d+\) failed to start fake-project while this one waited for it, so this one does not try again:\n/.test(
          stderr,
        ),
      );
      expect(waiters).toHaveLength(2);
      // the holder's record: its lock's token, and its checkout, which prune goes by
      expect(JSON.parse(readFileSync(join(locks, 'db-up-fake-project.failed'), 'utf8'))).toEqual({
        pid: expect.any(Number),
        token: expect.stringMatching(/^[0-9a-f-]{36}$/),
        root: tmp,
        reason: `docker compose up failed (exit 1):\n${transient[2]}\n`,
      });
    } finally {
      await stop();
    }
  }, 30_000);

  // It used to compare the record's time with its own start: a record from before a clock step
  // back (a VM's resume) failed every start, without a `compose up`, until it was deleted by hand.
  it('tries again on the record of a start it did not wait for, whatever its time', async () => {
    const { cfg, env, stop } = await fakeServer();
    const dir = lockDir();
    const future = { pid: 1, token: 'earlier', root: tmp, at: Date.now() + 3_600_000 };
    writeFileSync(
      join(dir, 'db-up-fake-project.failed'),
      JSON.stringify({ ...future, reason: 'an earlier failure' }),
    );
    try {
      const { error, calls } = await run(cfg, { env, options: { lockDir: dir } });
      expect({ error, calls }).toEqual({ error: undefined, calls: [...LISTS, UP] });
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      await stop();
    }
  }, 30_000);

  it('fails at once only on the record of the start whose lock it waited on', async () => {
    for (const [token, failsAtOnce] of [
      ['theirs', true], // the lock heldLock makes: the start it waited for failed
      ['another', false], // the record of a start whose lock it never saw
    ] as const) {
      const { cfg, env, stop } = await fakeServer();
      const lock = heldLock(process.pid);
      const record = join(lock.dir, 'db-up-fake-project.failed');
      // the holder fails a moment later: its record, then its lock goes
      const failed = setTimeout(() => {
        writeFileSync(record, JSON.stringify({ pid: 4242, token, root: tmp, reason: 'refused' }));
        rmSync(lock.file);
      }, 300);
      try {
        const { error, calls } = await run(cfg, { env, options: { lockDir: lock.dir } });
        if (failsAtOnce) {
          expect(error, token).toBe(
            '[db-up] another db-up (pid 4242) failed to start fake-project while this one waited for it, so this one does not try again:\nrefused',
          );
          expect(calls, token).toEqual([]); // not even the listings: no Docker call
          // the record stays as it is, for the others that waited
          expect(JSON.parse(readFileSync(record, 'utf8')), token).toMatchObject({
            pid: 4242,
            token,
          });
          expect(readdirSync(lock.dir), token).toEqual(['db-up-fake-project.failed']);
        } else {
          expect({ error, calls }, token).toEqual({ error: undefined, calls: [...LISTS, UP] });
          expect(readdirSync(lock.dir), token).toEqual([]);
        }
      } finally {
        clearTimeout(failed);
        await stop();
      }
    }
  }, 30_000);

  it('tries again when the last start failed before this one began', async () => {
    const { cfg, env, stop } = await fakeServer();
    const dir = lockDir();
    writeFileSync(
      join(dir, 'db-up-fake-project.failed'),
      JSON.stringify({ pid: 1, at: Date.now() - 1000, reason: 'an earlier failure' }),
    );
    try {
      const { error, calls } = await run(cfg, { env, options: { lockDir: dir } });
      expect({ error, calls }).toEqual({ error: undefined, calls: [...LISTS, UP] });
      expect(readdirSync(dir)).toEqual([]); // the record goes with the lock once a start works
    } finally {
      await stop();
    }
  }, 30_000);

  it('leaves the lock alone at its release when another process took it over meanwhile', async () => {
    const { cfg, env, stop } = await fakeServer();
    const dir = lockDir();
    const file = join(dir, 'db-up-fake-project.lock');
    try {
      // the fake `up` overwrites the lock with another process's, as a waiter's takeover does
      const { error, calls } = await run(cfg, {
        env: { ...env, FAKE_DOCKER_TAKEOVER: file },
        options: { lockDir: dir },
      });
      expect({ error, calls }).toEqual({ error: undefined, calls: [...LISTS, UP] });
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ token: 'theirs' });
    } finally {
      await stop();
    }
  }, 30_000);

  it.runIf(process.getuid)(
    'keeps its locks in a directory of this user’s own in the temp directory',
    async () => {
      const { cfg, env, stop } = await fakeServer();
      const temp = mkdtempSync(join(tmp, 'tmpdir-'));
      const log = join(tmp, `docker-${runs++}.log`);
      try {
        // no lockDir: db-up's own
        const args = { cfg, env: { ...env, FAKE_DOCKER_LOG: log }, ...fast };
        const results = await dbUpProcesses(1, () => args, { TMPDIR: temp });
        expect(results).toEqual([{ status: 0, stderr: '' }]);
        const dir = join(temp, `db-up-${process.getuid?.()}`);
        expect(statSync(dir).mode & 0o777).toBe(0o700);
        expect(readdirSync(dir)).toEqual([]); // released
      } finally {
        await stop();
      }
    },
    30_000,
  );
});

/** A start lock of fake-project in a fresh directory, holding `text`. */
function lockHolding(text: string) {
  const dir = lockDir();
  const file = join(dir, 'db-up-fake-project.lock');
  writeFileSync(file, text);
  return { dir, file };
}

describe('takeOver', () => {
  it('removes the lock while it still holds the text judged stale', () => {
    const { dir, file } = lockHolding('stale');
    expect(takeOver(file, 'stale')).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('keeps, with its age, a lock another process took since the stale one was read', () => {
    const { dir, file } = lockHolding('fresh');
    const old = new Date(Date.now() - 5000);
    utimesSync(file, old, old);
    expect(takeOver(file, 'stale')).toBe(false);
    expect(readdirSync(dir)).toEqual(['db-up-fake-project.lock']); // nothing left aside
    expect(readFileSync(file, 'utf8')).toBe('fresh');
    expect(Date.now() - statSync(file).mtimeMs).toBeGreaterThan(4000);
  });

  it('does nothing once the lock is gone', () => {
    expect(takeOver(join(lockDir(), 'db-up-fake-project.lock'), 'stale')).toBe(false);
  });
});

describe('alive', () => {
  it('tells a process that runs from one that has exited', () => {
    expect(alive(process.pid)).toBe(true);
    const gone = spawnSync(process.execPath, ['-e', '']).pid ?? 0;
    expect(gone).toBeGreaterThan(0);
    expect(alive(gone)).toBe(false);
  });
});

/** Wait, up to `ms`, until `check()` holds; whether it did. */
async function eventually(check: () => boolean, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (check()) return true;
  return check();
}

/** Process `pid` and its descendants, as a tree kill (Nx's) finds them. */
function processTree(pid: number): number[] {
  const listed = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout ?? '';
  const pids = listed.split('\n').filter(Boolean).map(Number);
  return [pid, ...pids.flatMap((child) => processTree(child))];
}

const hasPgrep = spawnSync('sh', ['-c', 'command -v pgrep'], { stdio: 'ignore' }).status === 0;
describe.runIf(hasPgrep)('the reaper', () => {
  // a process that does what this file does: its reaper, a process group of its own (which holds
  // that process's stdout: this one sees it end only once the group is gone too), a compose
  // project, and another one it removed itself; it says the group's pid once its reaper runs
  const code = `const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const reap = (change) => appendFileSync(process.env.REAP_LIST, JSON.stringify(change) + '\\n');
const group = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] });
reap({ group: group.pid });
reap({ project: { name: 'left-proj', composeFile: 'left.yml', port: 1 } });
reap({ project: { name: 'done-proj', composeFile: 'done.yml', port: 2 } });
reap({ unproject: 'done-proj' });
const env = { ...process.env, REAP_PID: String(process.pid) };
spawn(process.execPath, ['-e', process.env.REAPER], { detached: true, stdio: 'ignore', env }).on('exit', () => console.log(group.pid));
setInterval(() => {}, 1000);`;

  for (const [how, kill] of [
    ['that process alone', (pid: number) => [pid]],
    ['its whole process tree, as Nx does', processTree],
  ] as const)
    it(`kills the groups, removes the projects and the directory, when ${how} is killed`, async () => {
      const dir = mkdtempSync(join(tmp, 'reaped-'));
      const log = join(tmp, `docker-${runs++}.log`);
      const parent = spawn(process.execPath, ['-e', code], {
        env: {
          ...process.env,
          PATH: `${BIN}${delimiter}${process.env.PATH}`,
          FAKE_DOCKER_LOG: log,
          REAPER,
          REAP_DIR: dir,
          REAP_LIST: join(dir, 'reaper.jsonl'),
        },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const ended = new Promise((resolve) => parent.stdout.on('end', resolve));
      const group: number = await new Promise((resolve) =>
        parent.stdout.once('data', (chunk: Buffer) => resolve(Number(chunk.toString()))),
      );
      onTestFinished(() => {
        try {
          process.kill(-group, 'SIGKILL');
        } catch {
          // gone, as it should be
        }
      });
      // no hook of its own runs: SIGKILL
      for (const pid of kill(parent.pid ?? 0)) process.kill(pid, 'SIGKILL');
      const gone = await Promise.race([ended.then(() => 'gone'), sleep(10_000, 'still there')]);
      expect(gone).toBe('gone');
      expect(await eventually(() => !existsSync(dir))).toBe(true);
      expect(readFileSync(log, 'utf8')).toBe('compose -p left-proj -f left.yml down -v -t 0\n');
    }, 30_000);
});

const dockerRuns = spawnSync('docker', ['info', '--format', '{{.ID}}']).status === 0;

// The race itself, on Docker: three processes start one fresh compose project at once. Before the
// lock, two of the three `compose up` calls failed on the container's name (and lived only by
// their one immediate retry).
describe.runIf(dockerRuns)('dbUp in several processes at once, on Docker', () => {
  it('creates the container once: no process hits a name conflict', async () => {
    const project = `db-up-race-${randomBytes(4).toString('hex')}`;
    // its own project and port, never this checkout's, as a checkout of its own in this file's
    // temp directory, labeled with this repository and with this process as its owner. A run that
    // ends without its hooks (Ctrl-C: Vitest exits without them) leaves it to the reaper; if even
    // that one is killed, the next db-up start (or `pnpm prune:orphans`) removes it, since its
    // owner has exited (the temp directory outlives such a run)
    const root = mkdtempSync(join(tmp, 'race-checkout-'));
    const composeFile = join(root, 'docker-compose.yml');
    const owner = `${process.pid}@${hostname()}`;
    const text = readFileSync(join(DB, '../../docker-compose.yml'), 'utf8');
    const owned = text.replace(
      /^ {4}labels: &checkout\n/m,
      (labels) => `${labels}      ${LABELS.owner}: '${owner}'\n`,
    );
    expect(owned).not.toBe(text);
    writeFileSync(composeFile, owned);
    const port = await closedPort();
    const { commonDir } = resolveDb();
    const cfg = { ...local(port), project, composeFile, root, commonDir, ownsProject: true };
    reap({ project: { name: project, composeFile, port } });
    // the real docker, behind a script that logs each call
    const docker = spawnSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).stdout.trim();
    const bin = mkdtempSync(join(tmp, 'logging-bin-'));
    const log = join(tmp, `docker-${runs++}.log`);
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${docker}" "$@"\n`);
    chmodSync(join(bin, 'docker'), 0o755);
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
    // also when the test fails or times out: the processes first (afterEach), then what they made
    onTestFinished(() => {
      killChildren();
      spawnSync('docker', ['compose', '-p', project, '-f', composeFile, 'down', '-v'], {
        env: { ...process.env, DB_PORT: String(port), COMPOSE_PROJECT_NAME: project },
        stdio: 'ignore',
      });
      reap({ unproject: project });
    }, 30_000);
    // waits shorter than the test's: a process left running (the test process was killed) ends;
    // locks in this file's temp directory: a killed process's lock goes with it
    const options = { lockDir: lockDir(), staleMs: 30_000, backoffMs: 500 };
    const results = await dbUpProcesses(3, () => ({ cfg, env, ...options }));
    expect(results.map((r) => r.status)).toEqual([0, 0, 0]);
    for (const { stderr } of results) expect(stderr).not.toMatch(/Conflict|another start/);
    expect(ups(log)).toHaveLength(1);
    // the owner label prune goes by is on what compose made
    const labeled = spawnSync(
      'docker',
      ['container', 'ls', '--quiet', '--filter', `label=${LABELS.owner}=${owner}`],
      { encoding: 'utf8' },
    );
    expect(labeled.stdout.trim().split('\n').filter(Boolean)).toHaveLength(1);
  }, 60_000);
});

// A volume made before docker-compose.yml labeled it (or with other label values: a moved
// checkout) no longer matches the file, and Docker cannot relabel it. Compose asks "Recreate (data
// will be lost)?" and, with no terminal, takes its default, no: db-up must keep it so (no `--yes`).
describe.runIf(dockerRuns)('a volume made before the labels', () => {
  it('keeps its data when db-up starts the labeled server on it', async () => {
    const composeFile = join(DB, '../../docker-compose.yml');
    const text = readFileSync(composeFile, 'utf8');
    const image = text.match(/^ {4}image: (\S+)$/m)?.[1] ?? '';
    const before = text
      .replace(/\n {4}labels: &checkout\n(?: {6}.*\n)+/, '\n')
      .replace(/\n {4}labels: \*checkout\n/, '\n');
    expect(before).not.toContain('dev-checkout.');
    const beforeFile = join(tmp, 'compose-before-labels.yml');
    writeFileSync(beforeFile, before);
    const project = `db-up-test-${randomBytes(4).toString('hex')}`;
    const cfg = { ...local(await closedPort()), project, composeFile };
    const env = { ...process.env, DB_PORT: String(cfg.port), COMPOSE_PROJECT_NAME: project };
    const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8', env });
    const marker = (cmd: string) =>
      docker('run', '--rm', '-v', `${project}_pgdata:/v`, '--entrypoint', 'sh', image, '-c', cmd);
    reap({ project: { name: project, composeFile, port: cfg.port } });
    onTestFinished(() => reap({ unproject: project }));
    try {
      const old = docker('compose', '-p', project, '-f', beforeFile, 'create');
      expect(old.status, old.stderr).toBe(0);
      expect(marker('echo kept > /v/marker').status).toBe(0);
      await dbUp(cfg);
      expect(marker('cat /v/marker').stdout).toBe('kept\n');
    } finally {
      docker('compose', '-p', project, '-f', composeFile, 'down', '-v');
    }
  }, 60_000);
});

/**
 * FAKE_DOCKER_LS for `docker <kind> ls`: [kind, id, project, workingDir, root, commonDir = REPO,
 * owner = ''] per resource, as orphans.mjs formats them (id, then its LABELS' values).
 */
function listing(rows: string[][]) {
  const ls: Record<string, string> = {};
  for (const [
    kind = '',
    id,
    project,
    workingDir = '',
    root = '',
    commonDir = REPO,
    owner = '',
  ] of rows) {
    const labels =
      kind === 'network'
        ? ['', '', project, '', '']
        : [commonDir, root, project, workingDir, owner];
    ls[kind] = `${ls[kind] ?? ''}${[id, ...labels].map((v) => JSON.stringify(v)).join('\t')}\n`;
  }
  return ls;
}

/**
 * db-up.mjs `mode` in this checkout, with the fake docker first on PATH and a temp directory of
 * its own (TMPDIR: the lock directory, never this checkout's real one), unless `env` names one.
 */
function cli(mode: string, env: Record<string, string> = {}) {
  const log = join(tmp, `docker-${runs++}.log`);
  const res = spawnSync(process.execPath, ['scripts/db-up.mjs', mode], {
    cwd: DB,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${BIN}${delimiter}${process.env.PATH}`,
      FAKE_DOCKER_LOG: log,
      TMPDIR: mkdtempSync(join(tmp, 'tmpdir-')),
      ...env,
    },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  return { ...res, calls };
}

/** The pid of a process that has exited. */
function exitedPid() {
  const pid = spawnSync(process.execPath, ['-e', '']).pid ?? 0;
  expect(pid).toBeGreaterThan(0);
  return pid;
}

/**
 * A lock directory as db-up makes it (`db-up-<uid>` in the temp directory `temp`, this user's
 * alone) holding `files`, { name: text }.
 */
function lockFiles(files: Record<string, string>, temp = mkdtempSync(join(tmp, 'tmpdir-'))) {
  const dir = join(temp, `db-up-${process.getuid?.() ?? 'user'}`);
  mkdirSync(dir, { mode: 0o700 });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return { temp, dir };
}
const UUID = '0123abcd-0123-4567-89ab-0123456789ab';
/** A start lock's text, of process `pid`. */
const lockOf = (pid: number) => JSON.stringify({ pid, project: 'p', token: `token-${pid}` });
/** A failure record's text, written by the checkout `root` (none: an earlier version's). */
const recordOf = (root?: string) =>
  JSON.stringify({ pid: 1, token: 'theirs', root, reason: 'their failure' });

describe('down and prune', () => {
  const notRunning =
    'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n';

  it('down removes what this checkout’s starts left in the lock directory, Docker or not', () => {
    const { project } = resolveDb();
    const gone = exitedPid();
    const files = {
      // a failed start's record (of this checkout, which exists), a killed start's lock, and a
      // lock a takeover killed in that moment moved aside
      [`db-up-${project}.failed`]: recordOf(tmp),
      [`db-up-${project}.lock`]: lockOf(gone),
      [`db-up-${project}.lock.${gone}.${UUID}`]: lockOf(gone),
      // a takeover under way: never
      [`db-up-${project}.lock.${process.pid}.${UUID}`]: lockOf(gone),
      // another checkout's: prune's to judge
      'db-up-other.failed': recordOf(join(tmp, 'deleted-worktree')),
      'db-up-other.lock': lockOf(gone),
    };
    const kept = [`db-up-${project}.lock.${process.pid}.${UUID}`, 'db-up-other.failed'];
    for (const env of [{}, { FAKE_DOCKER_FAIL: notRunning }] as Record<string, string>[]) {
      const { temp, dir } = lockFiles(files);
      const res = cli('down', { TMPDIR: temp, ...env });
      expect(res.status, res.stderr).toBe(0);
      expect(readdirSync(dir).toSorted()).toEqual([...kept, 'db-up-other.lock'].toSorted());
    }
    // a project COMPOSE_PROJECT_NAME names is not this checkout's: its files stay too
    const { temp, dir } = lockFiles({ 'db-up-shared-pg.failed': recordOf(tmp) });
    cli('down', { TMPDIR: temp, COMPOSE_PROJECT_NAME: 'shared-pg' });
    expect(readdirSync(dir)).toEqual(['db-up-shared-pg.failed']);
  }, 30_000);

  it('prune removes the start locks’ leftovers of exited processes and deleted checkouts, Docker or not', () => {
    const gone = exitedPid();
    const files = {
      'db-up-deleted.failed': recordOf(join(tmp, 'deleted-worktree')),
      'db-up-live.failed': recordOf(tmp),
      'db-up-killed.lock': lockOf(gone),
      'db-up-running.lock': lockOf(process.pid),
      [`db-up-killed.lock.${gone}.${UUID}`]: lockOf(gone),
    };
    const removed = [
      'db-up-deleted.failed',
      'db-up-killed.lock',
      `db-up-killed.lock.${gone}.${UUID}`,
    ];
    for (const env of [{}, { FAKE_DOCKER_FAIL: notRunning }] as Record<string, string>[]) {
      const { temp, dir } = lockFiles(files);
      const res = cli('prune', { TMPDIR: temp, ...env });
      expect(res.status, res.stderr).toBe(0);
      const said = [
        `[db-up] removed 3 start lock files of exited processes and deleted checkouts from ${dir}:\n`,
        ...removed.map((name) => `[db-up]   ${name}\n`),
      ].join('');
      // then what Docker had (here nothing), or why it had nothing to say
      const docker = env.FAKE_DOCKER_FAIL
        ? `[db-up] docker container ls failed: ${notRunning.trim()}: no containers or volumes to prune\n`
        : '';
      expect(res.stdout).toBe(`${said}${docker}`);
      expect(readdirSync(dir).toSorted()).toEqual(['db-up-live.failed', 'db-up-running.lock']);
    }
  }, 30_000);

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

  it('down leaves a project COMPOSE_PROJECT_NAME names running: other checkouts may use it', () => {
    const shared = cli('down', { COMPOSE_PROJECT_NAME: 'shared-pg' });
    expect(shared.status, shared.stderr).toBe(0);
    expect(shared.calls).toEqual([]);
    expect(shared.stdout).toContain('[db-up] shared-pg is not this checkout’s own');
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

  it('prune removes the images of a deleted checkout’s stack, by name, and an untagged one by id', () => {
    const { commonDir } = resolveDb();
    const gone = join(tmp, 'deleted-worktree');
    const labels = (root: string) => ({
      'dev-checkout.git-common-dir': commonDir,
      'dev-checkout.root': root,
      'com.docker.compose.project': 'gone-stack',
    });
    const inspect = [
      { Id: 'sha256:aaa', RepoTags: ['gone-stack-api:latest'], Config: { Labels: labels(gone) } },
      { Id: 'sha256:bbb', RepoTags: [], Config: { Labels: labels(gone) } }, // an earlier build
      // this checkout's own (it exists): never a leftover
      { Id: 'sha256:ccc', RepoTags: ['live-stack-web:latest'], Config: { Labels: labels(tmp) } },
    ];
    const ls = { image: 'sha256:aaa\nsha256:bbb\nsha256:ccc\n', inspect: JSON.stringify(inspect) };
    const res = cli('prune', { FAKE_DOCKER_LS: JSON.stringify(ls) });
    expect(res.status, res.stderr).toBe(0);
    expect(res.calls).toContain('image inspect sha256:aaa sha256:bbb sha256:ccc');
    expect(res.calls.at(-1)).toBe('image rm gone-stack-api:latest sha256:bbb');
    expect(res.stdout).toBe(
      `[db-up] removed 2 images of deleted checkouts:\n[db-up]   gone-stack (${gone})\n`,
    );
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
    // what another remover (a test's reaper, another prune) is removing at that moment, which
    // Docker refuses in its own words, then is gone
    const both = listing([
      ['container', 'cid', 'gone-proj', gone, gone, commonDir],
      ['network', 'gone-proj_default', 'gone-proj'],
    ]);
    for (const said of [
      'Error response from daemon: removal of container cid is already in progress\n',
      'exit status 1\n',
    ]) {
      const removing = cli('prune', {
        FAKE_DOCKER_LS: JSON.stringify(both),
        FAKE_DOCKER_RM_FAIL: said,
        FAKE_DOCKER_GONE: '1',
      });
      expect(removing.status, said).toBe(0);
      expect(removing.stderr, said).toBe('');
      expect(removing.calls, said).toContain('container inspect cid');
      expect(removing.calls, said).toContain('network inspect gone-proj_default');
    }
    // and a refusal of what stays
    const refused = cli('prune', {
      FAKE_DOCKER_LS: ls,
      FAKE_DOCKER_RM_FAIL:
        'Error response from daemon: remove gone-proj_pgdata: volume is in use - [0123abcd]\n',
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toBe(
      '[db-up] could not prune: docker volume rm: Error response from daemon: remove gone-proj_pgdata: volume is in use - [0123abcd]\n',
    );
    // (asked a moment long whether it was gone)
    expect(refused.calls.filter((call) => call === 'volume inspect gone-proj_pgdata')).toHaveLength(
      10,
    );
  }, 30_000);

  // the on-Docker race test's project, after a run that ended without its hooks and its reaper
  it('prune removes a project whose owner process has exited, though its directories exist', () => {
    const { commonDir } = resolveDb();
    const here = hostname();
    const killed = `${exitedPid()}@${here}`;
    const ls = listing([
      // its temp checkout directory (and compose's working directory) are still there
      ['container', 'cid', 'owned-proj', tmp, tmp, commonDir, killed],
      ['volume', 'owned-proj_pgdata', 'owned-proj', '', tmp, commonDir, killed],
      ['network', 'owned-proj_default', 'owned-proj'],
      // a running process's, and another machine's (a container's pids are not this one's)
      [
        'volume',
        'running-proj_pgdata',
        'running-proj',
        '',
        tmp,
        commonDir,
        `${process.pid}@${here}`,
      ],
      [
        'volume',
        'remote-proj_pgdata',
        'remote-proj',
        '',
        tmp,
        commonDir,
        `${exitedPid()}@elsewhere`,
      ],
    ]);
    const res = cli('prune', { FAKE_DOCKER_LS: JSON.stringify(ls) });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toBe(
      `[db-up] removed 1 container, 1 volume, 1 network of deleted checkouts:\n[db-up]   owned-proj (${tmp})\n`,
    );
    expect(res.calls.slice(-3)).toEqual([
      'rm --force --volumes cid',
      'network rm owned-proj_default',
      'volume rm owned-proj_pgdata',
    ]);
  }, 30_000);
});

describe('cleanLocks', () => {
  it('removes the leftovers of exited processes and deleted checkouts, and nothing in use', () => {
    const gone = exitedPid();
    const { dir } = lockFiles({
      // locks: a killed start's, a running one's, and one being written (empty)
      'db-up-killed.lock': lockOf(gone),
      'db-up-running.lock': lockOf(process.pid),
      'db-up-new.lock': '',
      // moved aside by a takeover: one killed in that moment, one under way, an earlier version's
      [`db-up-killed.lock.${gone}.${UUID}`]: lockOf(gone),
      [`db-up-running.lock.${process.pid}.${UUID}`]: lockOf(gone),
      [`db-up-old.lock.${UUID}`]: lockOf(gone),
      // failure records: a deleted checkout's, a live one's, an earlier version's (no checkout)
      'db-up-deleted.failed': recordOf(join(tmp, 'deleted-worktree')),
      'db-up-live.failed': recordOf(tmp),
      'db-up-old.failed': JSON.stringify({ pid: 1, at: 0, reason: 'their failure' }),
      // not db-up's
      'notes.txt': '',
    });
    const removed = [
      'db-up-killed.lock',
      `db-up-killed.lock.${gone}.${UUID}`,
      `db-up-old.lock.${UUID}`,
      'db-up-deleted.failed',
      'db-up-old.failed',
    ].toSorted();
    expect(cleanLocks({ lockDir: dir })).toEqual(removed);
    expect(readdirSync(dir).toSorted()).toEqual(
      [
        'db-up-running.lock',
        'db-up-new.lock',
        `db-up-running.lock.${process.pid}.${UUID}`,
        'db-up-live.failed',
        'notes.txt',
      ].toSorted(),
    );
  });

  it('removes a lock older than staleMs too, whatever its process, as a waiter takes it over', () => {
    const { dir } = lockFiles({ 'db-up-hung.lock': lockOf(process.pid), 'db-up-new.lock': '' });
    const old = new Date(Date.now() - 5000);
    for (const name of readdirSync(dir)) utimesSync(join(dir, name), old, old);
    expect(cleanLocks({ lockDir: dir, staleMs: 1000 })).toEqual([
      'db-up-hung.lock',
      'db-up-new.lock',
    ]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('with a project, removes only its files, its failure record whatever its checkout', () => {
    const gone = exitedPid();
    const { dir } = lockFiles({
      'db-up-mine.failed': recordOf(tmp), // this checkout's own, which exists
      'db-up-mine.lock': lockOf(gone),
      [`db-up-mine.lock.${gone}.${UUID}`]: lockOf(gone),
      'db-up-other.failed': recordOf(join(tmp, 'deleted-worktree')),
      'db-up-other.lock': lockOf(gone),
    });
    expect(cleanLocks({ lockDir: dir, project: 'mine' })).toEqual([
      'db-up-mine.failed',
      'db-up-mine.lock',
      `db-up-mine.lock.${gone}.${UUID}`,
    ]);
    expect(readdirSync(dir).toSorted()).toEqual(['db-up-other.failed', 'db-up-other.lock']);
  });

  it.runIf(process.getuid)('touches nothing in a directory others can write to', () => {
    const { dir } = lockFiles({ 'db-up-killed.lock': lockOf(exitedPid()) });
    chmodSync(dir, 0o777);
    expect(cleanLocks({ lockDir: dir })).toEqual([]);
    expect(readdirSync(dir)).toEqual(['db-up-killed.lock']);
    expect(cleanLocks({ lockDir: join(tmp, 'no-such-dir') })).toEqual([]);
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

  it('refuses a URL whose host parameter sends pg elsewhere', () => {
    // pg connects to `?host=` rather than the URL's host name (db-seed-e2e would drop it there)
    for (const query of [
      'host=db.example.com',
      'sslmode=disable&host=10.0.0.5',
      'hostaddr=10.0.0.5',
    ])
      expect(isLocalUrl(`postgres://u:p@127.0.0.1:5432/e2e?${query}`), query).toBe(false);
    expect(isLocalUrl('postgres://u:p@127.0.0.1:5432/e2e?sslmode=disable')).toBe(true);
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

  it('drops a leading `--` (pnpm passes it on), and only that one', () => {
    const psql = ['exec', 'postgres', 'psql', '-U', 'postgres', '-d', 'app'];
    expect(psqlArgs('app', ['--', '-c', 'select 1'], { tty: true })).toEqual([
      ...psql,
      '-c',
      'select 1',
    ]);
    expect(psqlArgs('app', ['-c', '--'], { tty: true })).toEqual([...psql, '-c', '--']);
  });

  it('is what the root script `pnpm db:psql` runs, without Nx', () => {
    // the db tests rerun when it changes: the root package.json is one of their inputs
    expect(
      JSON.parse(readFileSync(join(DB, 'package.json'), 'utf8')).nx.targets.test.inputs,
    ).toContain('{workspaceRoot}/package.json');
    const root = JSON.parse(readFileSync(join(DB, '../../package.json'), 'utf8'));
    expect(root.scripts['db:psql']).toBe('node packages/db/scripts/db-up.mjs psql');
  });

  // what `pnpm db:psql -c "select …"` runs, in a shell with no terminal (an agent's)
  const url = process.env.TEST_FILE_DATABASE_URL ?? '';
  const onComposeServer = isLocalUrl(url) && Number(new URL(url).port) === resolveDb().port;
  /** `pnpm db:psql <args>` from the repo root, on this test file's own database. */
  const dbPsql = (...args: string[]) =>
    spawnSync('pnpm', ['db:psql', ...args], {
      cwd: join(DB, '../..'),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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

  // pnpm quotes each argument of a root script, and db-up hands them to docker as an argv array:
  // no shell reads them, so `nx run db:db-psql --args=…`'s lost commas cannot happen here, and
  // shell syntax in a query stays text. This is what makes `Bash(pnpm db:psql *)` a safe allow
  // rule.
  it.runIf(onComposeServer)(
    'pnpm db:psql passes each argument to psql intact: commas, quotes and shell syntax',
    () => {
      const marker = join(tmp, 'psql-pwned');
      const text = `it's "quoted", $(touch ${marker}); touch ${marker} \`touch ${marker}\` | x & y`;
      const query = `select 1 as a, 2 as b, '${text.replaceAll("'", "''")}' as c`;
      for (const args of [
        ['-tA', '-c', query],
        ['--', '-tA', '-c', query], // the `pnpm db:psql -- …` habit
      ]) {
        const res = dbPsql(...args);
        expect(res.stdout, res.stderr).toBe(`1|2|${text}\n`);
        expect(res.status).toBe(0);
      }
      expect(existsSync(marker)).toBe(false);
    },
    60_000,
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

  it('owns its compose project unless COMPOSE_PROJECT_NAME names another', () => {
    for (const checkout of [repo, worktree]) {
      const own = resolveDb(checkout, env);
      expect(own.ownsProject).toBe(true);
      // what `dev-ports --exec` exports to its children: the checkout's own name
      expect(resolveDb(checkout, { ...env, COMPOSE_PROJECT_NAME: own.project }).ownsProject).toBe(
        true,
      );
      const shared = resolveDb(checkout, { ...env, COMPOSE_PROJECT_NAME: 'shared-pg' });
      expect(shared).toMatchObject({ project: 'shared-pg', ownsProject: false });
    }
    // a worktree pointed at the primary checkout's project
    const primary = resolveDb(repo, env).project;
    expect(resolveDb(worktree, { ...env, COMPOSE_PROJECT_NAME: primary }).ownsProject).toBe(false);
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
