#!/usr/bin/env node
// This checkout's local Postgres (docker-compose.yml at the repo root), one compose project per
// checkout/worktree with names and ports from tools/dev-ports.mjs.
//
//   node scripts/db-up.mjs          start it (~1 s cold; ~10 ms when it is already running: no Docker call)
//   node scripts/db-up.mjs down     stop it (data kept), and remove its start lock's leftovers
//                                   (cleanLocks); succeeds when Docker is not running, and leaves a
//                                   project that is not this checkout's own running
//   node scripts/db-up.mjs prune    remove the containers, volumes and networks of this repository's
//                                   deleted checkouts (scripts/orphans.mjs; `up` does it too
//                                   whenever it has to start the server), and the start locks'
//                                   leftovers of exited processes and deleted checkouts
//   node scripts/db-up.mjs reset    delete it and its data, then start fresh
//   node scripts/db-up.mjs psql     open psql on the dev database; arguments after `psql` go to
//                                   psql (`-c "select …"` runs one query, also without a terminal)
//   node scripts/db-up.mjs studio   Drizzle Studio on this checkout's studio port
//
// Also imported by the Vitest global setup (`dbUp()`, `alive()`) and the migrate/seed scripts
// (`resolveDb()`, `isLocalUrl()`). Several processes may start the same server at once (Nx runs
// the tests of several db-using projects in parallel, each one's global setup calls `dbUp()`): one
// runs `compose up` while the others wait for its server (startLock), a pull or start that fails on
// a network or registry error is tried again (composeUp), and a start that fails anyway fails the
// processes that waited for it too, without tries of their own.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { alive, describePruned, pruneOrphans } from './orphans.mjs';

export { alive };

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
    // the labels docker-compose.yml puts on the container and volume (scripts/orphans.mjs), put
    // only on this checkout's own project: one named by COMPOSE_PROJECT_NAME may serve other
    // checkouts too, and must outlive this one
    root: info.root,
    commonDir: info.commonDir,
    ownsProject: info.ownsComposeProject === true,
  };
}

/**
 * True for a database URL on this machine (127.0.0.1, localhost, ::1), never a remote host. pg
 * connects to a `host` query parameter rather than the URL's host name: a URL with one (or with
 * `hostaddr`) is never taken for local.
 */
export function isLocalUrl(url) {
  const { hostname, searchParams } = new URL(url);
  if (searchParams.has('host') || searchParams.has('hostaddr')) return false;
  return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
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
  throw Object.assign(new Error(`[db-up] ${message}`), { dbUp: true, reason: message });
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
      DEV_CHECKOUT_ROOT: (cfg.ownsProject && cfg.root) || '',
      DEV_CHECKOUT_GIT_COMMON_DIR: (cfg.ownsProject && cfg.commonDir) || '',
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

/**
 * dbUp's timings (options of dbUp, which the tests shorten):
 * - lockDir: where each compose project's start lock lives: `db-up-<uid>` in the temp directory,
 *   a directory only this user can write to. Every process of this user on this machine shares
 *   it (macOS's per-user TMPDIR and Windows' %TEMP% included), and the processes that race are an
 *   Nx run's tasks, which share their environment;
 * - staleMs: a lock is taken over once its process has exited (Ctrl-C, a crash), at once, or once
 *   it is older than this or this process has waited on it this long (a reused pid, a start that
 *   hangs). Each lock is judged on its own: one another waiter has just taken gets the whole time.
 *   More than the longest start: a slow pull, its retries, the health check's wait;
 * - pollMs: how often a waiter checks for the server and the lock;
 * - noticeMs: how long a waiter waits before it says what for (then every 30 s);
 * - attempts, backoffMs: `compose up` runs at most `attempts` times when it fails on a transient
 *   error, waiting backoffMs before the second, then twice as long before each next one.
 */
const TIMINGS = {
  staleMs: 10 * 60_000,
  pollMs: 250,
  noticeMs: 5_000,
  attempts: 4,
  backoffMs: 2_000,
};

/** The start locks' directory: this user's own, in the temp directory. */
const defaultLockDir = () => join(tmpdir(), `db-up-${process.getuid?.() ?? 'user'}`);

/**
 * Check that `dir` is a directory only this user can write to. Anywhere others can write, another
 * user could leave a lock there that holds every db-up back (a live pid) or hangs it (a FIFO).
 * Where uids do not exist (Windows), the temp directory is the user's own already.
 */
function checkPrivateDir(dir) {
  const st = lstatSync(dir);
  const uid = process.getuid?.();
  if (!st.isDirectory() || (uid !== undefined && (st.uid !== uid || (st.mode & 0o022) !== 0)))
    throw new Error('not a directory only this user can write to');
}

/** Make `dir` (its parent must exist), or check it, as checkPrivateDir does. */
function privateDir(dir) {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  checkPrivateDir(dir);
}

/**
 * The lock's text and age, both of the one file opened: never through a link, and never blocked
 * on a FIFO (anything but a regular file is unusable).
 */
function readLock(file) {
  // (where a flag does not exist, Windows, `|` takes its undefined for 0)
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error('not a regular file');
    return { text: readFileSync(fd, 'utf8'), age: Date.now() - st.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

/**
 * Remove the lock `file` if it still holds `stale`, the text judged stale; true if this call
 * removed it. It is moved aside first (`<file>.<pid>.<uuid>`: a process killed before it removed
 * it leaves it to cleanLocks), which only one of several waiters that judged it stale can do: a
 * lock another waiter has taken in its place since is put back (with its age), not removed. (Only
 * if yet another waiter takes the free place in that moment do two hold it: then composeUp's
 * retry of the name conflict covers them.)
 */
export function takeOver(file, stale) {
  const aside = `${file}.${process.pid}.${randomUUID()}`;
  try {
    renameSync(file, aside);
  } catch (err) {
    if (err.code === 'ENOENT') return false; // released, or another waiter took it over
    throw err;
  }
  try {
    if (readFileSync(aside, 'utf8') === stale) return true;
    linkSync(aside, file);
    return false;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    rmSync(aside, { force: true });
  }
}

const seconds = (ms) => `${Math.round(ms / 1000)} s`;

/** A lock's process id and token (neither while it is being written, empty). */
function lockOwner(text) {
  try {
    const { pid, token } = JSON.parse(text);
    return { pid: Number.isInteger(pid) && pid > 0 ? pid : undefined, token };
  } catch {
    return {};
  }
}

/**
 * One start of `cfg.project` at a time, across processes: an exclusive lock file
 * (`<lockDir>/db-up-<project>.lock`, created with O_EXCL, holding its process id and a token of
 * its own). Resolves to the lock once this process holds it, or to undefined as soon as the
 * server answers while it waits (another process started it). It waits on no one lock for longer
 * than staleMs, and says what it waits for after noticeMs. Without a usable lock file (a lock
 * directory that is missing, unwritable or not this user's alone, a lock that is no regular file)
 * it starts unlocked: composeUp's retry of the name conflict then covers a concurrent start.
 *
 * A start that fails records its error beside the lock (`db-up-<project>.failed`) with its lock's
 * token. The lock's `failure` is that record if this process waited on that very lock: the start
 * it waited for failed. A record of a start it did not wait for (an earlier run's, one that failed
 * before this process came) is no reason to fail, whatever the clocks say. `release(reason)`
 * records this start's failure (`reason`; a record this process failed by stays as it is) or
 * clears the record once a start works, then removes the lock if it is still ours.
 */
async function startLock(cfg, { lockDir, staleMs, pollMs, noticeMs }) {
  const file = join(lockDir, `db-up-${cfg.project}.lock`);
  const record = join(lockDir, `db-up-${cfg.project}.failed`);
  const token = randomUUID();
  const mine = JSON.stringify({ pid: process.pid, project: cfg.project, token });
  const unlocked = (path, err) => {
    console.error(
      `[db-up] starting ${cfg.project} without its lock (${path}: ${err.code ?? err.message})`,
    );
    return { failure: undefined, release() {} };
  };
  try {
    privateDir(lockDir);
  } catch (err) {
    return unlocked(lockDir, err);
  }
  const t0 = Date.now();
  let notice = t0 + noticeMs;
  let waitingOn; // the lock this process waits on ({ text, since }): a new one restarts its clock
  const waitedOn = new Set(); // the tokens of all the locks it has waited on
  for (;;) {
    let fd;
    try {
      fd = openSync(file, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') return unlocked(file, err);
    }
    if (fd !== undefined) {
      try {
        writeSync(fd, mine);
      } catch (err) {
        closeSync(fd);
        rmSync(file, { force: true }); // an empty lock would hold the others back for staleMs
        return unlocked(file, err);
      }
      closeSync(fd);
      let failure;
      try {
        const failed = JSON.parse(readFileSync(record, 'utf8'));
        if (waitedOn.has(failed.token)) failure = failed;
      } catch {
        // no start has failed since the last one that worked
      }
      return {
        failure,
        release(reason) {
          try {
            // still ours: a waiter may have taken it over (staleMs) while this start hung
            if (readFileSync(file, 'utf8') !== mine) return;
            if (!reason) rmSync(record, { force: true });
            // with the checkout that wrote it: `prune` removes the records of deleted checkouts
            else if (!failure)
              writeFileSync(
                record,
                JSON.stringify({ pid: process.pid, token, root: cfg.root, reason }),
              );
            unlinkSync(file);
          } catch {
            // gone already
          }
        },
      };
    }
    let held;
    try {
      held = readLock(file);
    } catch (err) {
      if (err.code === 'ENOENT') continue; // released meanwhile: try again
      return unlocked(file, err);
    }
    if (waitingOn?.text !== held.text) waitingOn = { text: held.text, since: Date.now() };
    const waited = Date.now() - waitingOn.since;
    // read between its creation and its write (empty), the lock is judged by its age alone
    const { pid, token: theirs } = lockOwner(held.text);
    if (theirs) waitedOn.add(theirs);
    const exited = pid !== undefined && !alive(pid);
    if (exited || held.age > staleMs || waited > staleMs) {
      let removed;
      try {
        removed = takeOver(file, held.text);
      } catch (err) {
        return unlocked(file, err);
      }
      if (removed && !exited)
        console.error(
          `[db-up] taking over ${file} from pid ${pid ?? '?'} after ` +
            `${Math.round(Math.max(held.age, waited) / 1000)} s: its start of ${cfg.project} takes too long`,
        );
      continue; // race the other waiters for a new lock
    }
    if (await answers(cfg)) return undefined;
    if (Date.now() >= notice) {
      // the whole wait (behind earlier starts too), then this lock's own age, which staleMs bounds
      console.error(
        `[db-up] waiting for another db-up (pid ${pid ?? '?'}) to start ${cfg.project}: ` +
          `${seconds(Date.now() - t0)} so far. Its lock ${file} is taken over once that process ` +
          `exits, or once it is ${seconds(staleMs)} old (now ${seconds(Math.max(held.age, waited))}).`,
      );
      notice = Date.now() + 30_000;
    }
    await sleep(pollMs);
  }
}

// the files of the lock directory, each with its compose project (whose name has no dot): a start
// lock, a lock a takeover moved aside (with that process's pid, a uuid), a failed start's record
const LOCK = /^db-up-([^.]+)\.lock$/;
const ASIDE =
  /^db-up-([^.]+)\.lock\.(?:(\d+)\.)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECORD = /^db-up-([^.]+)\.failed$/;

/**
 * Remove what starts left in the lock directory, never a file a running process still uses: locks
 * a takeover moved aside whose process has exited (killed in that moment), locks whose process
 * has exited or that are older than staleMs (a killed or hung start's, which the next start would
 * take over), and the failure records of checkouts that are gone (a record serves only the
 * processes that waited for that start, and the next start that works removes it). With
 * `project`, only that project's files, and its failure record whatever its checkout (`down`).
 * Returns the names of the files it removed: none where the directory is missing or not this
 * user's alone.
 */
export function cleanLocks({
  lockDir = defaultLockDir(),
  project,
  staleMs = TIMINGS.staleMs,
  exists = existsSync,
} = {}) {
  let names;
  try {
    checkPrivateDir(lockDir);
    names = readdirSync(lockDir).toSorted();
  } catch {
    return [];
  }
  const ofProject = (match) => match && (project === undefined || match[1] === project);
  const removed = [];
  for (const name of names) {
    const file = join(lockDir, name);
    const aside = ASIDE.exec(name);
    const lock = LOCK.exec(name);
    const record = RECORD.exec(name);
    try {
      if (ofProject(aside)) {
        if (aside[2] && alive(Number(aside[2]))) continue; // a takeover under way
        unlinkSync(file);
      } else if (ofProject(lock)) {
        const held = readLock(file);
        const { pid } = lockOwner(held.text);
        if ((pid === undefined || alive(pid)) && held.age <= staleMs) continue;
        if (!takeOver(file, held.text)) continue; // taken since
      } else if (ofProject(record)) {
        if (project === undefined) {
          // the checkout that wrote it (none: an earlier version's record, of no use)
          const { root } = JSON.parse(readLock(file).text);
          if (root && exists(root)) continue;
        }
        unlinkSync(file);
      } else continue;
      removed.push(name);
    } catch {
      // removed meanwhile, or no regular file, or a record half written (the next prune's)
    }
  }
  return removed;
}

// `compose up` failures that db-up explains itself, never retried
const NOT_RUNNING =
  /Cannot connect to the Docker daemon|Is the docker daemon running|docker\.sock/i;
const PORT_TAKEN = /port is already allocated|address already in use/i;
// Failures another `compose up` may not have: the registry or the network to it failing for a
// moment (a cold machine pulls the image: CI), and a start outside the lock (another lock
// directory, a bare `docker compose up`) that created the container (or its network) first, which
// the next `up` finds and starts. Any other failure (a denied pull, an unhealthy server) is
// reported at once. Compose prints warnings on stderr too: `volume "…" already exists but was not
// created by Docker Compose` is one, on every `up` of a volume made outside compose, and no race.
const TRANSIENT =
  /context deadline exceeded|Client\.Timeout exceeded|TLS handshake timeout|i\/o timeout|Gateway Time-?out|toomanyrequests|connection reset by peer/i;
const CONFLICT = /is already in use by container|network with name \S+ already exists/i;

/** `compose up -d --wait`, run again with a growing wait while it fails on a transient error. */
async function composeUp(cfg, env, { attempts, backoffMs }) {
  for (let attempt = 1; ; attempt++) {
    const res = compose(cfg, ['up', '-d', '--wait'], { env });
    const err = res.stderr ?? '';
    const why =
      res.status === 0 || NOT_RUNNING.test(err) || PORT_TAKEN.test(err)
        ? undefined
        : CONFLICT.test(err)
          ? 'another start created its container first'
          : TRANSIENT.exec(err)?.[0];
    if (!why || attempt >= attempts) return res;
    const delay = backoffMs * 2 ** (attempt - 1);
    console.error(
      `[db-up] docker compose up failed (${why}): try ${attempt + 1} of ${attempts} in ${delay / 1000} s`,
    );
    await sleep(delay);
  }
}

/**
 * Start this checkout's Postgres if it is not running, and wait until it accepts connections.
 * `options` override TIMINGS and `lockDir` (default: `db-up-<uid>` in the temp directory).
 */
export async function dbUp(cfg = resolveDb(), { env = process.env, ...options } = {}) {
  const timings = { ...TIMINGS, lockDir: defaultLockDir(), ...options };
  // this checkout's server: on this machine, on its port (a Postgres URL without one means 5432)
  const ours = (url) => isLocalUrl(url) && Number(new URL(url).port || 5432) === cfg.port;
  // DATABASE_URL / TEST_DATABASE_URL point elsewhere (CI, prod-like runs): not ours to start
  if (!ours(cfg.url) && !ours(cfg.adminUrl) && !env.DB_UP_FORCE) return cfg;
  if (await answers(cfg)) return cfg;
  const lock = await startLock(cfg, timings);
  if (!lock) return cfg; // started by the process this one waited for
  let reason;
  try {
    // the start this process waited for failed (a registry that keeps failing, Docker stopped):
    // the same failure, without another round of tries
    return await start(cfg, env, timings, lock.failure);
  } catch (err) {
    if (err.dbUp) reason = err.reason;
    throw err;
  } finally {
    lock.release(reason);
  }
}

/** dbUp's part under the lock: the server did not answer a moment ago. */
async function start(cfg, env, timings, failed) {
  // the process this one waited for released the lock just now: its server may answer
  if (await answers(cfg)) return cfg;
  if (failed)
    fail(
      `another db-up (pid ${failed.pid}) failed to start ${cfg.project} while this one waited ` +
        `for it, so this one does not try again:\n${failed.reason}`,
    );
  // Docker gets called anyway: clear deleted checkouts' leftovers first (their containers may hold
  // a port the registry has since handed to a new worktree)
  pruneQuietly(cfg, env);
  const res = await composeUp(cfg, env, timings);
  const err = res.stderr ?? '';
  if (res.error?.code === 'ENOENT')
    fail('Docker is not installed (no `docker` on PATH). Install Docker Engine with Compose v2.');
  if (NOT_RUNNING.test(err))
    fail(
      `Docker is not running. Start it and retry.\n  docker said: ${err.trim().split('\n').at(-1)}`,
    );
  if (PORT_TAKEN.test(err)) {
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
    // `pnpm teardown` runs this in every checkout, but a project COMPOSE_PROJECT_NAME names may
    // serve other checkouts too (resolveDb): it stays up
    if (!cfg.ownsProject) {
      console.log(
        `[db-up] ${cfg.project} is not this checkout’s own (COMPOSE_PROJECT_NAME): other checkouts may use it, so it keeps running (\`docker compose -p ${cfg.project} down\` stops it)`,
      );
      return;
    }
    // what its starts left in the lock directory (a failed start's record, a killed one's lock),
    // Docker or not
    cleanLocks({ project: cfg.project });
    // nothing runs without Docker, so nothing to stop
    const res = compose(cfg, ['down'], { stdio: ['ignore', 'inherit', 'pipe'] });
    if (noDocker(res)) {
      console.log(`[db-up] Docker is not running: nothing to stop for ${cfg.project}`);
      return;
    }
    process.stderr.write(res.stderr ?? '');
    process.exitCode = res.status ?? 1;
  } else if (mode === 'prune') {
    // the start locks' leftovers first: they need no Docker
    const files = cleanLocks();
    if (files.length) {
      const what = `${files.length} start lock file${files.length === 1 ? '' : 's'}`;
      console.log(
        `[db-up] removed ${what} of exited processes and deleted checkouts from ${defaultLockDir()}:`,
      );
      for (const name of files) console.log(`[db-up]   ${name}`);
    }
    let pruned;
    try {
      pruned = pruneOrphans(cfg);
    } catch (err) {
      if (!err.docker) throw err;
      console.log(`[db-up] ${err.message}: no containers or volumes to prune`);
      return;
    }
    const lines = describePruned(pruned);
    for (const line of lines.length || files.length ? lines : ['no leftovers of deleted checkouts'])
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
