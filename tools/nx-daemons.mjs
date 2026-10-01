#!/usr/bin/env node
// What Nx daemons leave behind. Every workspace (each git worktree) gets its own Nx daemon. Each
// one started without NX_USE_LOCAL=true installs nx@latest (~4k files) into `<tmp>/tmp-<pid>-*`
// and never removes it: its cleanup is asynchronous and the daemon exits before it finishes, even
// on a clean `nx daemon --stop` (Nx 23.2). A daemon whose checkout is deleted exits by itself in
// Nx 23.2 (it checks every 20 ms that its pid file and lock file are unchanged), leaving that copy;
// one that misses it (another Nx version, a stuck process) keeps running with its watchers.
//
//   node tools/nx-daemons.mjs prune   stop (SIGTERM, its own clean shutdown) every Nx daemon of
//                                     this user whose workspace directory is gone, then delete
//                                     the temp Nx installs of processes that have exited
//
// A daemon's workspace is its working directory (Nx starts it in the workspace root). Linux and
// macOS; elsewhere it does nothing. `nx daemon --stop` stops the current checkout's own daemon.
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
 * Stop the Nx daemons whose workspace directory no longer exists. Returns [{ pid, workspace }].
 * `ps` (the process listing) and `cwd` (pid → working directory) can be replaced in tests.
 */
export function pruneDaemons({
  ps = listProcesses,
  cwd = workingDir,
  exists = existsSync,
  kill = (pid) => process.kill(pid, 'SIGTERM'),
  uid = process.getuid?.(), // undefined on Windows, where `ps` lists nothing either
} = {}) {
  const stopped = [];
  for (const pid of daemonPids(ps(), uid)) {
    const workspace = cwd(pid);
    // the raw link: a deleted directory reads "<path> (deleted)", which does not exist either
    if (workspace === undefined || exists(workspace)) continue;
    try {
      kill(pid);
      stopped.push({ pid, workspace: workspace.replace(/ \(deleted\)$/, '') });
    } catch {
      // exited meanwhile
    }
  }
  return stopped;
}

/**
 * Nx's temp installs whose process has exited: `<dir>/tmp-<pid>-<random>` directories of this
 * user holding a package.json that depends on Nx packages only (`nx`, `@nx/*`), as Nx writes them.
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
  const stopped = pruneDaemons();
  if (stopped.length === 0) console.log('[nx-daemons] no Nx daemons of deleted checkouts');
  for (const { pid, workspace } of stopped)
    console.log(`[nx-daemons] stopped the Nx daemon of deleted ${workspace} (pid ${pid})`);
  // the daemons just stopped exit within moments; their temp installs are stale once they have
  for (let i = 0; i < 50 && stopped.some(({ pid }) => isAlive(pid)); i++)
    await new Promise((done) => setTimeout(done, 100));
  const stale = staleTempInstalls();
  for (const path of stale) rmSync(path, { recursive: true, force: true });
  if (stale.length)
    console.log(
      `[nx-daemons] deleted ${stale.length} temp Nx install${stale.length === 1 ? '' : 's'} of exited processes in ${tmpdir()}`,
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
