// tools/e2e-stack.mjs, behind `pnpm nx run web-e2e:e2e-stack`: the steps it runs against the
// production images' stack, in order, with a fake runner in place of docker and pnpm.
import { execFileSync, spawn } from 'node:child_process';
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

describe.runIf(process.platform !== 'win32')('e2e-stack interrupted', () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * `node tools/e2e-stack.mjs` in its own process group (as a terminal's foreground job is), with a
   * fake `docker` that logs its calls and a fake `pnpm` whose spec run takes `specs` seconds.
   *
   * Its watcher (`tools/stack-down.mjs --after <its pid>`) runs outside that group and outlives it:
   * after a kill it removes the stack through the fake docker, which writes in the temp dir. Each
   * test waits until the watcher has exited (`watching`), so the dir goes only once nothing writes
   * there any more.
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
    const exited = new Promise((done) =>
      child.on('exit', (code, signal) => done({ code, signal })),
    );
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
    const downs = () => calls().filter((call) => / down --volumes --rmi local/.test(call));
    const until = async (ok, ms = 10_000) => {
      for (let t = 0; t < ms && !ok(); t += 50) await new Promise((r) => setTimeout(r, 50));
      return ok();
    };
    // whether its watcher runs, found in the process list by its arguments (`-ww`: whole command
    // lines, on Linux and macOS); one that has exited but is not yet reaped lists none
    const watching = () =>
      execFileSync('ps', ['-A', '-ww', '-o', 'args='], { encoding: 'utf8' })
        .split('\n')
        .some((args) => args.includes(`stack-down.mjs --after ${child.pid} `));
    return { child, exited, calls, downs, until, watching, specsRunning: () => existsSync(ready) };
  }

  it('still removes the stack when Ctrl-C reaches it mid-run', async () => {
    const { child, exited, calls, downs, until, watching, specsRunning } = run();
    expect(await until(specsRunning), 'the specs never started').toBe(true);
    expect(await until(watching), 'no watcher').toBe(true);
    process.kill(-(child.pid ?? 0), 'SIGINT'); // Ctrl-C signals the whole foreground group
    expect(await exited).toEqual({ code: 130, signal: null });
    const specs = calls().findIndex((call) => call.includes('e2e-base-url'));
    const down = calls().findIndex((call) => / down --volumes --rmi local/.test(call));
    expect(specs).toBeGreaterThan(-1);
    expect(down, calls().join('\n')).toBeGreaterThan(specs);
    // its own cleanup ran, so the watcher exits and does nothing more
    expect(await until(() => !watching()), 'the watcher never exited').toBe(true);
    expect(downs()).toHaveLength(1);
  }, 30_000);

  it('still removes the stack when its whole process tree is killed (what Nx does on Ctrl-C)', async () => {
    const { child, exited, downs, until, watching, specsRunning } = run();
    expect(await until(specsRunning), 'the specs never started').toBe(true);
    expect(await until(watching), 'no watcher').toBe(true);
    process.kill(-(child.pid ?? 0), 'SIGKILL');
    expect(await exited).toEqual({ code: null, signal: 'SIGKILL' });
    // the watcher, outside the killed tree, notices and removes it; it goes on after `down` (the
    // untagged images, through the fake docker again), so the test ends once it has exited
    expect(await until(() => downs().length > 0), 'no stack-down after the kill').toBe(true);
    expect(await until(() => !watching()), 'the watcher never exited').toBe(true);
    expect(downs()).toHaveLength(1);
  }, 30_000);

  it('removes the stack once after a normal run: the watcher stands down', async () => {
    const { exited, downs, until, watching } = run({ specs: 0 });
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(await until(() => !watching()), 'the watcher never exited').toBe(true);
    expect(downs()).toHaveLength(1);
  }, 30_000);
});
