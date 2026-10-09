// tools/e2e-stack.mjs, behind `pnpm nx run web-e2e:e2e-stack`: the steps it runs against the
// production images' stack, in order, with a fake runner in place of docker and pnpm.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computePorts } from '../dev-ports.mjs';
import { e2eStack } from '../e2e-stack.mjs';

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
