import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  daemonPids,
  deletedWorkspace,
  isAlive,
  listProcesses,
  pruneDaemons,
  sameMounts,
  staleTempInstalls,
  workingDir,
} from '../nx-daemons.mjs';
import { tempDir } from './helpers.mjs';

const SCRIPT = resolve(import.meta.dirname, '../nx-daemons.mjs');
const START = 'node_modules/.pnpm/nx@23.2.1/node_modules/nx/dist/src/daemon/server/start.js';

describe('daemonPids', () => {
  it("finds the user's Nx daemons in a process listing, in both Nx layouts", () => {
    const ps = [
      `  101  1000 /usr/bin/node /work/app/${START}`,
      `  102  1000 node /work/old app/node_modules/nx/src/daemon/server/start.js`,
      `  103  1001 /usr/bin/node /work/other-user/${START}`, // another user's
      `  104  1000 /usr/bin/node /work/app/node_modules/nx/dist/src/project-graph/plugins/isolation/plugin-worker.js`,
      `  105  1000 /usr/bin/node /work/app/node_modules/nx/bin/nx.js daemon --start`,
      `  106  1000 vim /work/app/${START}.bak`,
      '',
    ].join('\n');
    expect(daemonPids(ps, 1000)).toEqual([101, 102]);
  });
});

/**
 * Four daemons: one in a deleted workspace, one in a live one, one whose workspace is unknown, and
 * one in a container (another mount namespace), whose workspace does not exist on this machine.
 */
const ps = () =>
  [1, 2, 3, 4].map((pid) => `${pid} 1000 node /w/${pid}/${START}\n`).join('') +
  `5 1000 /sbin/docker-init -- node /workspaces/app/${START}\n`;
const cwds = { 1: '/w/gone (deleted)', 2: '/w/live', 3: undefined, 4: '/workspaces/app', 5: '/' };
const linux = {
  ps,
  cwd: (pid) => cwds[pid],
  mounts: (pid) => pid < 4,
  exists: (dir) => dir === '/w/live' || dir === '/',
  platform: 'linux',
  uid: 1000,
};
const refuse = (code) => () => {
  throw Object.assign(new Error(`kill ${code}`), { code });
};

describe('pruneDaemons', () => {
  it('stops the daemons whose workspace directory was deleted, and only those', () => {
    const killed = [];
    const { stopped, failed } = pruneDaemons({ ...linux, kill: (pid) => killed.push(pid) });
    expect(stopped).toEqual([{ pid: 1, workspace: '/w/gone' }]);
    expect(failed).toEqual([]);
    // never one whose workspace it cannot tell (3), nor a container's (4, 5): alive, elsewhere
    expect(killed).toEqual([1]);
  });

  it('leaves a container’s daemon alone even when the kernel marks its directory deleted', () => {
    const killed = [];
    const deleted = { ...linux, cwd: (pid) => `/w/${pid} (deleted)`, exists: () => false };
    pruneDaemons({ ...deleted, kill: (pid) => killed.push(pid) });
    expect(killed).toEqual([1, 2, 3]);
  });

  it('does not report a daemon that exited meanwhile, and reports one that refused the signal', () => {
    expect(pruneDaemons({ ...linux, kill: refuse('ESRCH') })).toEqual({ stopped: [], failed: [] });
    expect(pruneDaemons({ ...linux, kill: refuse('EACCES') })).toEqual({
      stopped: [],
      failed: [{ pid: 1, workspace: '/w/gone', error: 'EACCES' }],
    });
  });
});

describe('deletedWorkspace', () => {
  it('on Linux, trusts only the kernel’s " (deleted)" mark, and not for a recreated directory', () => {
    const opts = { platform: 'linux', exists: (dir) => dir === '/w/again' };
    expect(deletedWorkspace('/w/gone (deleted)', opts)).toBe('/w/gone');
    expect(deletedWorkspace('/workspaces/app', opts)).toBeUndefined(); // missing, not deleted
    expect(deletedWorkspace('/w/again (deleted)', opts)).toBeUndefined();
    expect(deletedWorkspace(undefined, opts)).toBeUndefined();
  });

  it('on macOS (lsof, no mark), takes a directory that does not exist', () => {
    const opts = { platform: 'darwin', exists: (dir) => dir === '/w/live' };
    expect(deletedWorkspace('/w/gone', opts)).toBe('/w/gone');
    expect(deletedWorkspace('/w/live', opts)).toBeUndefined();
  });
});

/** A process running <workspace>/<START>, started in <workspace> as Nx starts its daemon. */
function fakeDaemon(workspace, code = 'setInterval(() => {}, 1000);\n') {
  const script = join(workspace, START);
  mkdirSync(join(script, '..'), { recursive: true });
  writeFileSync(script, code);
  const child = spawn(process.execPath, [script], { cwd: workspace, stdio: 'ignore' });
  onTestFinished(() => child.kill('SIGKILL'));
  return child;
}

const byPid = (a, b) => a - b;

/** The signal that ended `child`, once it has exited. */
const exitSignal = (child) =>
  new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) done(child.signalCode);
    else child.once('exit', (_code, signal) => done(signal));
  });

// Real processes shaped like Nx daemons: one whose workspace is then deleted, one whose is not.
describe.runIf(['linux', 'darwin'].includes(process.platform))('on this machine', () => {
  it('stops a daemon whose workspace was deleted under it, and leaves the live one running', async () => {
    const parent = realpathSync(tempDir());
    const [goneDir, liveDir] = [join(parent, 'gone'), join(parent, 'live')];
    const gone = fakeDaemon(goneDir);
    const live = fakeDaemon(liveDir);
    // both are listed, with their working directories
    await new Promise((r) => setTimeout(r, 200));
    const ours = () =>
      listProcesses()
        .split('\n')
        .filter((line) => [gone.pid, live.pid].includes(Number(line.trim().split(/\s+/)[0])))
        .join('\n');
    expect(daemonPids(ours(), process.getuid()).toSorted(byPid)).toEqual(
      [gone.pid, live.pid].toSorted(byPid),
    );
    expect(workingDir(live.pid)).toBe(liveDir);

    expect(sameMounts(live.pid)).toBe(true);
    rmSync(goneDir, { recursive: true, force: true });
    const { stopped, failed } = pruneDaemons({ ps: ours });
    expect(stopped).toEqual([{ pid: gone.pid, workspace: goneDir }]);
    expect(failed).toEqual([]);
    expect(await exitSignal(gone)).toBe('SIGTERM');
    expect(live.exitCode).toBeNull();
    expect(live.signalCode).toBeNull();
  });

  it('kills a daemon that ignores SIGTERM, and says it stopped one only once it has', async () => {
    const parent = realpathSync(tempDir());
    const ignoreTerm = "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n";
    const workspace = join(parent, 'stuck');
    const stuck = fakeDaemon(workspace, ignoreTerm);
    // one whose parent (`sleep`) never reaps it: killed, it stays a zombie, which kill(pid, 0)
    // still finds, like a daemon that outlives SIGKILL too
    const undead = join(parent, 'undead');
    mkdirSync(join(undead, START, '..'), { recursive: true });
    writeFileSync(join(undead, START), ignoreTerm);
    const sh = ['-c', '"$0" "$1" & echo $!; exec sleep 60', process.execPath, START];
    const keeper = spawn('sh', sh, { cwd: undead, stdio: ['ignore', 'pipe', 'ignore'] });
    onTestFinished(() => keeper.kill('SIGKILL')); // its zombie child goes with it
    const zombie = Number(await new Promise((r) => keeper.stdout.once('data', r)));
    onTestFinished(() => isAlive(zombie) && process.kill(zombie, 'SIGKILL'));
    await new Promise((r) => setTimeout(r, 200));
    rmSync(workspace, { recursive: true, force: true });
    rmSync(undead, { recursive: true, force: true });
    // the CLI's `ps` lists these two processes only; its temp-install sweep stays in `parent`
    const bin = join(parent, 'bin');
    mkdirSync(bin);
    const listing = [
      `${stuck.pid} ${process.getuid()} node ${join(workspace, START)}`,
      `${zombie} ${process.getuid()} node ${join(undead, START)}`,
    ];
    writeFileSync(join(bin, 'ps'), `#!/bin/sh\necho '${listing.join('\n')}'\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, TMPDIR: parent };
    // asynchronously: this process reaps the killed child while the CLI waits for it to go
    const res = await promisify(execFile)(process.execPath, [SCRIPT, 'prune'], { env }).then(
      (done) => ({ ...done, code: 0 }),
      (failed) => failed,
    );
    const exited = await Promise.race([
      exitSignal(stuck),
      new Promise((r) => setTimeout(() => r('still running'), 2000)),
    ]);
    expect(exited).toBe('SIGKILL');
    expect(res.stdout).toContain(
      `stopped the Nx daemon of deleted ${workspace} (pid ${stuck.pid})`,
    );
    // the one still there after SIGKILL (a zombie: it got the signal) is reported, never as stopped
    const state = spawnSync('ps', ['-o', 'stat=', '-p', String(zombie)], { encoding: 'utf8' });
    expect(state.stdout.trim()).toMatch(/^Z/);
    expect(res.stdout).not.toContain(undead);
    expect(res.stderr).toContain(
      `could not stop the Nx daemon of deleted ${undead} (pid ${zombie}): still running after SIGTERM and SIGKILL`,
    );
    expect(res.code).toBe(1);
  }, 30_000);
});

describe.runIf(process.platform === 'linux')('sameMounts', () => {
  it('knows a process of this mount namespace, and says no when it cannot tell', () => {
    expect(sameMounts(process.pid)).toBe(true);
    const done = spawnSync(process.execPath, ['-e', '']);
    expect(sameMounts(done.pid)).toBe(false); // exited: no /proc entry to compare
  });
});

describe('staleTempInstalls', () => {
  it("finds this user's temp Nx installs whose process has exited, and nothing else", () => {
    const dir = tempDir();
    const make = (name, pkg) => {
      mkdirSync(join(dir, name, 'node_modules'), { recursive: true });
      if (pkg) writeFileSync(join(dir, name, 'package.json'), JSON.stringify(pkg));
    };
    const nx = { devDependencies: { nx: '^23.2.1' } };
    make('tmp-111-AbCdEf123456', nx); // the daemon's nx@latest, its process gone
    make('tmp-112-AbCdEf123456', { dependencies: { '@nx/js': 'latest', nx: 'latest' } });
    make('tmp-222-AbCdEf123456', nx); // its process still runs
    make('tmp-113-AbCdEf123456', { devDependencies: { nx: '1', 'left-pad': '1' } }); // not Nx's
    make('tmp-114-AbCdEf123456', { dependencies: {} });
    make('tmp-115-AbCdEf123456'); // no package.json
    make('nx-111-AbCdEf123456', nx); // another naming
    writeFileSync(join(dir, 'tmp-116-AbCdEf123456'), JSON.stringify(nx)); // a file
    const stale = staleTempInstalls({ dir, alive: (pid) => pid === 222, uid: process.getuid() });
    expect(stale.toSorted((a, b) => a.localeCompare(b))).toEqual([
      join(dir, 'tmp-111-AbCdEf123456'),
      join(dir, 'tmp-112-AbCdEf123456'),
    ]);
    // another user's are not ours to delete
    expect(staleTempInstalls({ dir, alive: () => false, uid: process.getuid() + 1 })).toEqual([]);
  });

  it('finds the temp npm directories Nx left with nothing installed, and nothing like them', () => {
    const dir = tempDir();
    // what Nx 23.2's createTempNpmDirectory() writes: `{}` and its copy of pnpm-workspace.yaml
    const make = (name, files) => {
      mkdirSync(join(dir, name));
      for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, name, file), text);
    };
    const empty = { 'package.json': '{}', 'pnpm-workspace.yaml': 'packages:\n  - .\n' };
    make('tmp-111-AbCdEf123456', empty);
    make('tmp-112-AbCdEf123456', { ...empty, '.npmrc': 'registry=https://example.com/\n' });
    make('tmp-222-AbCdEf123456', empty); // its process still runs
    make('tmp-113-AbCdEf123456', { ...empty, 'notes.txt': 'mine' }); // something else too
    make('tmp-114-AbCdEf123456', { 'package.json': '{}' }); // no pnpm-workspace.yaml
    make('tmp-115-AbCdEf123456', { ...empty, 'package.json': '{"name":"mine"}' }); // not empty
    make('tmp-116-AbCdEf123456', { ...empty, 'package.json': '[]' });
    make('tmp-117-AbCdEf123456', empty);
    mkdirSync(join(dir, 'tmp-117-AbCdEf123456', 'node_modules')); // a directory in it
    make('tmp-119-AbCdEf123456', empty);
    make('tmp-119-AbCdEf123456/.npmrc', { keep: 'mine' }); // a directory, named like Nx's file
    make('nx-118-AbCdEf123456', empty); // another naming
    const stale = staleTempInstalls({ dir, alive: (pid) => pid === 222, uid: process.getuid() });
    expect(stale.toSorted((a, b) => a.localeCompare(b))).toEqual([
      join(dir, 'tmp-111-AbCdEf123456'),
      join(dir, 'tmp-112-AbCdEf123456'),
    ]);
    // another user's are not ours to delete
    expect(staleTempInstalls({ dir, alive: () => false, uid: process.getuid() + 1 })).toEqual([]);
  });

  it('knows a running process from an exited one', () => {
    expect(isAlive(process.pid)).toBe(true);
    const done = spawnSync(process.execPath, ['-e', '']);
    expect(isAlive(done.pid)).toBe(false);
  });
});

describe('CLI', () => {
  it('names its one mode when given another', () => {
    const res = spawnSync(process.execPath, [SCRIPT, 'stop'], { encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('usage: node tools/nx-daemons.mjs prune');
  });

  it.runIf(process.platform !== 'win32')('prune deletes the temp Nx directories it finds', () => {
    const dir = tempDir();
    // no daemons to stop: a `ps` that lists nothing
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'ps'), '#!/bin/sh\n', { mode: 0o755 });
    const gone = join(dir, `tmp-${spawnSync(process.execPath, ['-e', '']).pid}-AbCdEf123456`);
    mkdirSync(gone);
    writeFileSync(join(gone, 'package.json'), '{}');
    writeFileSync(join(gone, 'pnpm-workspace.yaml'), 'packages:\n  - .\n');
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, TMPDIR: dir };
    const res = spawnSync(process.execPath, [SCRIPT, 'prune'], { encoding: 'utf8', env });
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(gone)).toBe(false);
    expect(res.stdout).toContain(`deleted 1 temp Nx directory of exited processes in ${dir}`);
  });
});

describe.runIf(process.platform !== 'win32')('pnpm prune:orphans', () => {
  it('runs the Docker part when the Nx-daemon part fails, and fails with it', () => {
    const repo = resolve(import.meta.dirname, '../..');
    const { scripts } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
    // a machine without `ps` (a slim image) fails the Nx-daemon part; a fake docker logs its calls
    const bin = tempDir();
    const git = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    symlinkSync(process.execPath, join(bin, 'node'));
    symlinkSync(git, join(bin, 'git'));
    const log = join(bin, 'docker.log');
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "$@" >> '${log}'\n`, { mode: 0o755 });
    const res = spawnSync('/bin/sh', ['-c', scripts['prune:orphans']], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PATH: bin, TMPDIR: bin },
    });
    expect(res.status).not.toBe(0);
    expect(existsSync(log) && readFileSync(log, 'utf8'), res.stderr).toContain('container ls');
    // the Docker part is the db project's script: a change there must rerun this cached test
    const tools = JSON.parse(readFileSync(join(repo, 'tools/package.json'), 'utf8'));
    expect(tools.nx.targets.test.inputs).toContain('{workspaceRoot}/packages/db/scripts/*.mjs');
  }, 30_000);
});
