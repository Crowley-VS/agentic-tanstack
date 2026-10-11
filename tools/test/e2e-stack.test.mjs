// tools/e2e-stack.mjs, behind `pnpm nx run web-e2e:e2e-stack`: the steps it runs against the
// production images' stack, in order, with a fake runner in place of docker and pnpm.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computePorts } from '../dev-ports.mjs';
import { e2eStack } from '../e2e-stack.mjs';
import { stackGuard } from '../stack-guard.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const checkout = { root: '/work/my-app', primary: true, commonDir: '/work/my-app/.git' };
const compose = 'docker compose -p my-app-stack -f /work/my-app/docker-compose.stack.yml';

/**
 * e2eStack with a fake runner that records each call (`line`: the command line, `env`); the calls
 * whose line `failing` matches exit 3. The database's port lookup prints 127.0.0.1:54321.
 */
function e2e({ info = computePorts(checkout), env = {}, failing, args } = {}) {
  const calls = [];
  const run = (command, argv, callEnv, capture) => {
    const line = [command === process.execPath ? 'node' : command, ...argv].join(' ');
    calls.push({ line, env: callEnv });
    if (failing?.test(line)) return { status: 3 };
    return { status: 0, stdout: capture ? '127.0.0.1:54321\n' : null };
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = e2eStack(info, env, run, args);
  return { code, calls, lines: calls.map((call) => call.line) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('e2eStack', () => {
  it('starts the stack, seeds it, migrates it again, runs every spec, then removes it', () => {
    const { code, calls, lines } = e2e();
    expect(code).toBe(0);
    expect(lines).toEqual([
      `${compose} up --detach --wait`,
      `${compose} port db 5432`,
      'pnpm nx run db:db-seed --excludeTaskDependencies',
      `${compose} run --rm -T migrate`,
      'pnpm nx run web-e2e:e2e-base-url',
      'node /work/my-app/tools/stack-down.mjs',
    ]);
    // the specs write dozens of notes from one address
    expect(calls[0]?.env).toMatchObject({ STACK_WRITE_RATE_LIMIT: 'off', STACK_PORT: '3200' });
    // the stack's database, on the port Docker picked, never the dev database
    expect(calls[2]?.env.DATABASE_URL).toBe('postgresql://app:app@127.0.0.1:54321/app');
    // the stack's web server, with the seed required: no spec skips for want of it
    expect(calls[4]?.env).toMatchObject({
      BASE_URL: 'http://127.0.0.1:3200',
      E2E_SEEDED: '1',
      E2E_REQUIRE_STACK: '1',
    });
    expect(calls[4]?.env.API_URL).toBeUndefined(); // the API stays private
  });

  it('runs the nested Nx commands as runs of their own, without this task’s NX_TASK_*', () => {
    const env = { NX_TASK_TARGET_TARGET: 'e2e-stack', NX_TASK_HASH: '1', NX_WORKSPACE_ROOT: '/w' };
    const { calls } = e2e({ env });
    const nested = calls.filter((call) => call.line.startsWith('pnpm nx '));
    expect(nested).toHaveLength(2);
    for (const { env: nestedEnv } of nested) {
      expect(Object.keys(nestedEnv).filter((key) => key.startsWith('NX_TASK_'))).toEqual([]);
      expect(nestedEnv.NX_WORKSPACE_ROOT).toBe('/w');
    }
  });

  it('passes extra arguments on to Playwright', () => {
    const { lines } = e2e({ args: ['--workers=3', '-g', 'board'] });
    expect(lines).toContain('pnpm nx run web-e2e:e2e-base-url -- --workers=3 -g board');
  });

  it('stops at the first failed step, still removes the stack, and fails with that step', () => {
    for (const [failing, ran] of [
      [/ up /, 1],
      [/db:db-seed/, 3],
      [/ run --rm -T migrate/, 4],
      [/e2e-base-url/, 5],
    ]) {
      const { code, lines } = e2e({ failing });
      expect(code, String(failing)).toBe(3);
      expect(lines.slice(0, -1), String(failing)).toHaveLength(ran);
      expect(lines.at(-1), String(failing)).toBe('node /work/my-app/tools/stack-down.mjs');
    }
  });

  it('fails when only removing the stack fails', () => {
    const { code, lines } = e2e({ failing: /stack-down/ });
    expect(code).toBe(3);
    expect(lines).toHaveLength(6);
  });

  it('refuses a stack this checkout does not own, and runs nothing', () => {
    const { code, calls } = e2e({ info: computePorts(checkout, { STACK_PROJECT: 'theirs' }) });
    expect(code).toBe(1);
    expect(calls).toEqual([]);
  });

  it('is what `pnpm nx run web-e2e:e2e-stack` runs, after building both images, never cached', () => {
    const e2eProject = JSON.parse(readFileSync(join(REPO, 'apps/web-e2e/package.json'), 'utf8'));
    expect(e2eProject.nx.targets['e2e-stack']).toEqual({
      command: 'node tools/e2e-stack.mjs',
      options: { cwd: '{workspaceRoot}' },
      cache: false,
      dependsOn: [{ projects: ['api', 'web'], target: 'docker-build' }],
    });
  });
});

describe('stackGuard', () => {
  it('lets a checkout build and run its own stack, and CI the project it names', () => {
    expect(stackGuard(computePorts(checkout)).ok).toBe(true);
    expect(stackGuard(computePorts(checkout, { CI: 'true', STACK_PROJECT: 'ci-stack' })).ok).toBe(
      true,
    );
  });

  it("refuses another checkout's stack, naming it", () => {
    const theirs = stackGuard(computePorts(checkout, { STACK_PROJECT: 'theirs-stack' }));
    expect(theirs.ok).toBe(false);
    expect(theirs.message).toContain('theirs-stack is not this checkout’s own stack');
    expect(stackGuard(computePorts(checkout, { COMPOSE_PROJECT_NAME: 'shared' })).ok).toBe(false);
  });

  it('runs before every command that builds, tags or starts the stack', () => {
    const target = (project, name) =>
      JSON.parse(readFileSync(join(REPO, `apps/${project}/package.json`), 'utf8')).nx.targets[name]
        .command;
    for (const [project, name] of [
      ['api', 'docker-build'],
      ['web', 'docker-build'],
      ['web-e2e', 'stack-up'],
    ])
      expect(target(project, name), `${project}:${name}`).toMatch(
        /^node tools\/stack-guard\.mjs && /,
      );
  });
});

// Each wait below has a budget of its own (wall clock), and a test's timeout is more than all of its
// waits together (five at most): a slow or broken run fails naming the step that did not happen,
// never with Vitest's timeout, which would also run the cleanup while the test still waits.
const WAIT = 10_000;

/** Polls `ok` until it holds or `ms` have passed; returns whether it holds. */
const until = async (ok, ms = WAIT) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (ok()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
};

/**
 * The pids of the watchers of process `pid` (`tools/stack-down.mjs --after <pid> …`), found by
 * their arguments. pgrep prints only the pids that match, so its output stays small however long
 * the machine's other command lines are (`ps -A -ww` prints them all, past spawnSync's 1 MiB
 * default buffer). One that has exited but is not yet reaped matches none.
 */
function watchersOf(pid) {
  const res = spawnSync('pgrep', ['-f', `stack-down\\.mjs --after ${pid} `], {
    encoding: 'utf8',
  });
  if (res.status === 1) return []; // none matches
  if (res.status !== 0) throw res.error ?? new Error(`pgrep: exit code ${res.status}`);
  return res.stdout.trim().split('\n').map(Number);
}

/** The process group of process `pid`, or undefined once it has exited. */
const groupOf = (pid) =>
  Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()) ||
  undefined;

/**
 * Sends `signal` to process `target` (a negative one: that process group); returns whether it
 * runs (EPERM: as another user's). Signal 0 only asks.
 */
const kill = (target, signal) => {
  try {
    process.kill(target, signal);
    return true;
  } catch (error) {
    return error?.code === 'EPERM'; // ESRCH: none left
  }
};

/**
 * Kills what e2e-stack (`child`) still runs, as after a test that failed early: its own process
 * group (with the fake pnpm's spec run) and each watcher's, a session of its own (with the fake
 * docker the watcher runs), so that nothing writes in the temp dir any more. Returns whether all
 * of them have exited within the wait; a watcher that starts late is killed on a later round.
 */
function stop(child) {
  const own = groupOf(process.pid);
  const groups = new Set();
  // once e2e-stack has exited, so has what it ran: its group is gone, its pid free for reuse
  if (child.exitCode === null && child.signalCode === null) {
    groups.add(child.pid);
    kill(-child.pid, 'SIGKILL');
  }
  return until(() => {
    for (const watcher of watchersOf(child.pid)) {
      const group = groupOf(watcher);
      if (!group) continue; // it has just exited
      if (group === own) kill(watcher, 'SIGKILL'); // never this test's own group
      else if (kill(-group, 'SIGKILL')) groups.add(group);
    }
    return [...groups].every((group) => !kill(-group, 0)) && watchersOf(child.pid).length === 0;
  });
}

/** The file e2e-stack `pid` leaves after a normal end, for its watcher to remove. */
const markerOf = (pid) => join(tmpdir(), `e2e-stack-${pid}-removed`);

describe.runIf(process.platform !== 'win32')('e2e-stack interrupted', { timeout: 6 * WAIT }, () => {
  /** What run() started: temp dirs and e2e-stack processes. */
  const dirs = [];
  const children = [];
  afterEach(async () => {
    const pids = children.map((child) => child.pid);
    const left = [];
    try {
      for (const child of children.splice(0)) if (!(await stop(child))) left.push(child.pid);
    } finally {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
      for (const pid of pids) rmSync(markerOf(pid), { force: true });
    }
    expect(left, 'e2e-stack or its watcher still runs').toEqual([]);
  }, 2 * WAIT);

  /**
   * `node tools/e2e-stack.mjs` in its own process group (as a terminal's foreground job is), with a
   * fake `docker` that logs its calls and a fake `pnpm` whose spec run takes `specs` seconds.
   *
   * Its watcher (`tools/stack-down.mjs --after <its pid>`) runs outside that group and outlives it:
   * after a kill it removes the stack through the fake docker, which writes in the temp dir. Each
   * test waits until the watcher has exited (`watching`), and the cleanup first kills whatever a
   * failed test left running, so the dir goes only once nothing writes there any more.
   */
  function run({ specs = 20 } = {}) {
    const bin = mkdtempSync(join(tmpdir(), 'e2e-stack-int-'));
    dirs.push(bin);
    const log = join(bin, 'calls.log');
    const ready = join(bin, 'specs-running');
    const which = (name) =>
      execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
    symlinkSync(process.execPath, join(bin, 'node'));
    symlinkSync(which('git'), join(bin, 'git'));
    const fake = (name, body) =>
      writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\n${body}\n`, {
        mode: 0o755,
      });
    fake('docker', `case "$*" in *' port db 5432') echo 127.0.0.1:54321;; esac`);
    fake(
      'pnpm',
      `case "$*" in *e2e-base-url*) : > '${ready}'; '${which('sleep')}' ${specs};; esac`,
    );
    const overrides = ['CI', 'STACK_PROJECT', 'COMPOSE_PROJECT_NAME', 'STACK_PORT'];
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !overrides.includes(k) && !k.startsWith('DEV_CHECKOUT_') && !k.startsWith('NX_'),
      ),
    );
    const child = spawn(process.execPath, ['tools/e2e-stack.mjs'], {
      cwd: REPO,
      env: { ...env, PATH: bin },
      detached: true,
      stdio: 'ignore',
    });
    const { pid } = child;
    // a signal to `-pid` reaches its group; to -0 it would reach this test's own
    if (!pid) throw new Error('e2e-stack did not start');
    children.push(child);
    // how it exited (`{ code, signal }`), once it has within the wait
    const exited = async () =>
      (await until(() => child.exitCode !== null || child.signalCode !== null))
        ? { code: child.exitCode, signal: child.signalCode }
        : 'still running';
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
    const downs = () => calls().filter((call) => / down --volumes --rmi local/.test(call));
    return {
      pid,
      exited,
      calls,
      downs,
      watching: () => watchersOf(pid).length > 0,
      specsRunning: () => existsSync(ready),
      markerLeft: () => existsSync(markerOf(pid)),
    };
  }

  it('still removes the stack when Ctrl-C reaches it mid-run', async () => {
    const { pid, exited, calls, downs, watching, specsRunning, markerLeft } = run();
    expect(await until(specsRunning), 'the specs never started').toBe(true);
    expect(await until(watching), 'no watcher').toBe(true);
    process.kill(-pid, 'SIGINT'); // Ctrl-C signals the whole foreground group
    expect(await exited()).toEqual({ code: 130, signal: null });
    const specs = calls().findIndex((call) => call.includes('e2e-base-url'));
    const down = calls().findIndex((call) => / down --volumes --rmi local/.test(call));
    expect(specs).toBeGreaterThan(-1);
    expect(down, calls().join('\n')).toBeGreaterThan(specs);
    // its own cleanup ran, so the watcher only removes the marker it left, and exits
    expect(await until(() => !watching()), 'the watcher never exited').toBe(true);
    expect(downs()).toHaveLength(1);
    expect(markerLeft(), 'marker left behind').toBe(false);
  });

  it('still removes the stack when its whole process tree is killed (what Nx does on Ctrl-C)', async () => {
    const { pid, exited, downs, watching, specsRunning, markerLeft } = run();
    expect(await until(specsRunning), 'the specs never started').toBe(true);
    expect(await until(watching), 'no watcher').toBe(true);
    process.kill(-pid, 'SIGKILL');
    expect(await exited()).toEqual({ code: null, signal: 'SIGKILL' });
    // the watcher, outside the killed tree, notices and removes it; it goes on after `down` (the
    // untagged images, through the fake docker again), so the test ends once it has exited
    expect(await until(() => downs().length > 0), 'no stack-down after the kill').toBe(true);
    expect(await until(() => !watching()), 'the watcher never exited').toBe(true);
    expect(downs()).toHaveLength(1);
    expect(markerLeft(), 'marker left behind').toBe(false);
  });

  it('removes the stack once after a normal run: the watcher stands down', async () => {
    const { exited, downs, watching, markerLeft } = run({ specs: 0 });
    expect(await exited()).toEqual({ code: 0, signal: null });
    expect(await until(() => !watching()), 'the watcher never exited').toBe(true);
    expect(downs()).toHaveLength(1);
    // the watcher found the marker this run left, and removed it: without a watcher it stays
    expect(markerLeft(), 'marker left behind').toBe(false);
  });

  it('finds a watcher however long the other command lines on the machine are', async () => {
    // over 1 MiB of command lines in all (spawnSync's default buffer, which `ps -A -ww` overflowed),
    // as Chrome or Electron helpers make them; ps prints at most 128 KiB of each one (procps)
    const pad = 'x'.repeat(100_000);
    const sleepers = [];
    const sleeper = (...args) => {
      const proc = spawn('/bin/sh', ['-c', 'sleep 60; exit', 'sh', ...args], {
        detached: true,
        stdio: 'ignore',
      });
      sleepers.push(proc);
      if (!proc.pid) throw new Error('sh did not start');
      return proc.pid;
    };
    try {
      for (let i = 0; i < 12; i++) sleeper(pad);
      // a watcher of this test's own process, which no e2e-stack is
      const watcher = sleeper('stack-down.mjs', '--after', String(process.pid), '--unless', 'x');
      const all = execFileSync('ps', ['-A', '-ww', '-o', 'args='], { maxBuffer: 256 * 1024 ** 2 });
      expect(all.length).toBeGreaterThan(1024 ** 2);
      expect(watchersOf(process.pid)).toEqual([watcher]);
      process.kill(-watcher, 'SIGKILL');
      expect(await until(() => watchersOf(process.pid).length === 0), 'still listed').toBe(true);
    } finally {
      for (const { pid } of sleepers) if (pid) kill(-pid, 'SIGKILL');
    }
  });
});
