#!/usr/bin/env node
// What Nx daemons leave behind. Every workspace (each git worktree) gets its own Nx daemon. Each
// one started without NX_USE_LOCAL=true installs nx@latest (~4k files) into `<tmp>/tmp-<pid>-*`
// and never removes it: its cleanup is asynchronous and the daemon exits before it finishes, even
// on a clean `nx daemon --stop` (Nx 23.2). A daemon whose checkout is deleted exits by itself in
// Nx 23.2 (it checks every 20 ms that its pid file and lock file are unchanged), leaving that copy;
// one that misses it (another Nx version, a stuck process) keeps running with its watchers.
//
//   node tools/nx-daemons.mjs prune   stop (SIGTERM, its own clean shutdown; SIGKILL if it still
//                                     runs 5 s later) every Nx daemon of this user whose workspace
//                                     directory was deleted, then delete the temp Nx installs (and
//                                     empty temp npm directories) of processes that have exited
//
// A daemon's workspace is its working directory (Nx starts it in the workspace root). On Linux it
// is gone only when the kernel marks that directory deleted, and only for a daemon in this mount
// namespace: one in a container (a devcontainer's, often the same uid) has paths of its own that do
// not exist here, and is alive. Linux and macOS; elsewhere it does nothing. `nx daemon --stop`
// stops the current checkout's own daemon.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The daemon's entry point, in both Nx package layouts (`nx/dist/src/…`, older `nx/src/…`). */
const DAEMON = /[\\/]nx[\\/](?:dist[\\/])?src[\\/]daemon[\\/]server[\\/]start\.js(?:\s|$)/;

/** Pure: pids of the Nx daemons owned by `uid` in `ps -A -o pid=,uid=,args=` output. */
export function daemonPids(psOutput, uid) {
  return psOutput
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m) => m && Number(m[2]) === uid && DAEMON.test(m[3]))
    .map((m) => Number(m[1]));
}

/**
 * Where process `pid` runs: Linux `/proc/<pid>/cwd` (" (deleted)" appended once the directory is
 * gone), macOS `lsof`. Undefined when it cannot tell, and then the daemon is left alone.
 */
export function workingDir(pid, { platform = process.platform } = {}) {
  try {
    if (platform === 'linux') return readlinkSync(`/proc/${pid}/cwd`);
    if (platform === 'darwin') {
      const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return out.match(/^n(.+)$/m)?.[1];
    }
  } catch {
    // gone already, or not ours to inspect
  }
  return undefined;
}

/**
 * True when process `pid` sees this process's mounts (Linux: the same mount namespace), so its
 * working directory is a path on this machine; false for a container's process, or when it cannot
 * tell. Always true elsewhere (macOS runs containers in a VM: their processes are not listed).
 */
export function sameMounts(pid, { platform = process.platform } = {}) {
  if (platform !== 'linux') return true;
  try {
    return readlinkSync(`/proc/${pid}/ns/mnt`) === readlinkSync('/proc/self/ns/mnt');
  } catch {
    return false;
  }
}

/**
 * Pure: the deleted workspace a daemon's working directory `dir` (from workingDir) names, else
 * undefined. Linux appends " (deleted)" to a removed directory's link: a path that merely does not
 * exist is no proof, and neither is a deleted one recreated since.
 */
export function deletedWorkspace(dir, { platform = process.platform, exists = existsSync } = {}) {
  if (dir === undefined) return undefined;
  const path = platform === 'linux' ? dir.match(/^(.*) \(deleted\)$/)?.[1] : dir;
  return path !== undefined && !exists(path) ? path : undefined;
}

/** Every process: `pid uid args` lines. */
export function listProcesses() {
  if (process.platform === 'win32') return '';
  return execFileSync('ps', ['-A', '-o', 'pid=,uid=,args='], { encoding: 'utf8' });
}

/** True while process `pid` exists (someone else's included). */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Stop the Nx daemons whose workspace directory has been deleted. Returns { stopped, failed }:
 * [{ pid, workspace }], and the same with `error` for those that refused the signal. `ps` (the
 * process listing), `cwd` (pid → working directory) and `mounts` (pid → sameMounts) can be
 * replaced in tests.
 */
export function pruneDaemons({
  ps = listProcesses,
  cwd = workingDir,
  mounts = sameMounts,
  exists = existsSync,
  platform = process.platform,
  kill = (pid) => process.kill(pid, 'SIGTERM'),
  uid = process.getuid?.(), // undefined on Windows, where `ps` lists nothing either
} = {}) {
  const stopped = [];
  const failed = [];
  for (const pid of daemonPids(ps(), uid)) {
    if (!mounts(pid)) continue; // a container's daemon: alive, its paths are not this machine's
    const workspace = deletedWorkspace(cwd(pid), { platform, exists });
    if (workspace === undefined) continue;
    try {
      kill(pid);
      stopped.push({ pid, workspace });
    } catch (err) {
      // ESRCH: exited meanwhile; anything else (EPERM: a sandbox's or security module's refusal)
      // leaves it running, and is said so
      if (err.code !== 'ESRCH') failed.push({ pid, workspace, error: err.code ?? err.message });
    }
  }
  return { stopped, failed };
}

/**
 * True for what Nx's createTempNpmDirectory() leaves when nothing got installed into it: plain
 * files only, package.json `{}` and Nx's copy of the workspace's pnpm-workspace.yaml (and of its
 * .npmrc, if it has one). `pkg` is the directory's parsed package.json.
 */
function emptyTempNpmDir(path, pkg) {
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) return false;
  const entries = readdirSync(path, { withFileTypes: true });
  if (Object.keys(pkg).length > 0 || !entries.every((e) => e.isFile())) return false;
  const names = entries.map((e) => e.name).filter((name) => name !== '.npmrc');
  return names.toSorted().join() === 'package.json,pnpm-workspace.yaml';
}

/**
 * Nx's temp directories whose process has exited: `<dir>/tmp-<pid>-<random>` directories of this
 * user holding a package.json that depends on Nx packages only (`nx`, `@nx/*`), as Nx writes them,
 * or Nx's temp npm setup with nothing installed (emptyTempNpmDir).
 */
export function staleTempInstalls({
  dir = tmpdir(),
  alive = isAlive,
  uid = process.getuid?.(),
} = {}) {
  const stale = [];
  for (const name of readdirSync(dir)) {
    const pid = Number(name.match(/^tmp-(\d+)-[A-Za-z0-9]+$/)?.[1]);
    if (!pid || alive(pid)) continue;
    const path = join(dir, name);
    try {
      if (statSync(path).uid !== uid) continue;
      const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
      if (deps.length && deps.every((d) => d === 'nx' || d.startsWith('@nx/'))) stale.push(path);
      else if (emptyTempNpmDir(path, pkg)) stale.push(path);
    } catch {
      // not a directory, no package.json: not Nx's
    }
  }
  return stale;
}

async function main([mode]) {
  if (mode !== 'prune') {
    console.error('usage: node tools/nx-daemons.mjs prune');
    process.exitCode = 1;
    return;
  }
  if (process.platform === 'win32') return;
  const { stopped, failed } = pruneDaemons();
  const waitFor = async (ticks) => {
    for (let i = 0; i < ticks && stopped.some(({ pid }) => isAlive(pid)); i++)
      await new Promise((done) => setTimeout(done, 100));
  };
  // the daemons just signalled exit within moments; their temp installs are stale once they have
  await waitFor(50);
  // one that ignores SIGTERM (stuck, or paused) serves no one either: SIGKILL it
  for (const { pid } of stopped.filter((d) => isAlive(d.pid)))
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone meanwhile, or refused: checked below
    }
  await waitFor(20);
  for (const daemon of stopped.filter((d) => isAlive(d.pid))) {
    stopped.splice(stopped.indexOf(daemon), 1);
    failed.push({ ...daemon, error: 'still running after SIGTERM and SIGKILL' });
  }
  if (stopped.length + failed.length === 0)
    console.log('[nx-daemons] no Nx daemons of deleted checkouts');
  for (const { pid, workspace } of stopped)
    console.log(`[nx-daemons] stopped the Nx daemon of deleted ${workspace} (pid ${pid})`);
  for (const { pid, workspace, error } of failed)
    console.error(
      `[nx-daemons] could not stop the Nx daemon of deleted ${workspace} (pid ${pid}): ${error}`,
    );
  if (failed.length) process.exitCode = 1;
  const stale = staleTempInstalls();
  for (const path of stale) rmSync(path, { recursive: true, force: true });
  if (stale.length)
    console.log(
      `[nx-daemons] deleted ${stale.length} temp Nx director${stale.length === 1 ? 'y' : 'ies'} of exited processes in ${tmpdir()}`,
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
