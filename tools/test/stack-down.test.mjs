// tools/stack-down.mjs: what removing the production-image stack runs (pure), and `pnpm teardown`,
// which runs it with no Nx in between, against a fake docker that logs its calls.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computePorts } from '../dev-ports.mjs';
import { stackDownCommands } from '../stack-down.mjs';
import { tempDir } from './helpers.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const checkout = { root: '/work/my-app', primary: true, commonDir: '/work/my-app/.git' };

describe('stackDownCommands', () => {
  it("removes the checkout's own stack, its images, and the untagged images of earlier builds", () => {
    expect(stackDownCommands(computePorts(checkout))).toEqual({
      commands: [
        [
          'compose',
          '-p',
          'my-app-stack',
          '-f',
          '/work/my-app/docker-compose.stack.yml',
          'down',
          '--volumes',
          '--rmi',
          'local',
          '--remove-orphans',
        ],
        [
          'image',
          'prune',
          '--force',
          '--filter',
          'label=dev-checkout.root=/work/my-app',
          '--filter',
          'label=dev-checkout.git-common-dir=/work/my-app/.git',
        ],
      ],
    });
  });

  it('leaves a stack STACK_PROJECT or COMPOSE_PROJECT_NAME names, but for the CI run’s own', () => {
    for (const env of [{ STACK_PROJECT: 'theirs' }, { COMPOSE_PROJECT_NAME: 'shared' }]) {
      const { skip, commands } = stackDownCommands(computePorts(checkout, env));
      expect(commands).toBeUndefined();
      expect(skip).toMatch(/^(theirs|shared-stack) is not this checkout’s own stack/);
    }
    const ci = stackDownCommands(computePorts(checkout, { CI: 'true', STACK_PROJECT: 'ci-stack' }));
    expect(ci.commands?.[0]?.slice(0, 3)).toEqual(['compose', '-p', 'ci-stack']);
  });
});

/**
 * `pnpm teardown` in this repository with a fake `docker` (and `nx`) first on PATH: each logs its
 * arguments; docker prints `message` to stderr and exits 3 for the calls the case pattern
 * `failing` matches.
 */
function teardown({ env = {}, failing = '', message = 'boom' } = {}) {
  const { scripts } = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  const bin = tempDir();
  const git = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  symlinkSync(process.execPath, join(bin, 'node'));
  symlinkSync(git, join(bin, 'git'));
  const log = join(bin, 'calls.log');
  const fake = (name, body = '') =>
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\n${body}`, {
      mode: 0o755,
    });
  fake('nx');
  fake('docker', failing ? `case "$*" in ${failing}) echo '${message}' >&2; exit 3;; esac\n` : '');
  // what dev-ports honours, as a developer or CI may have exported it
  const overrides = ['CI', 'STACK_PROJECT', 'COMPOSE_PROJECT_NAME', 'STACK_PORT'];
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !overrides.includes(k) && !k.startsWith('DEV_CHECKOUT_'),
    ),
  );
  const res = spawnSync('/bin/sh', ['-c', scripts.teardown], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...clean, PATH: bin, ...env },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  return { ...res, calls };
}

describe.runIf(process.platform !== 'win32')('pnpm teardown', () => {
  const stackDown = (calls) => calls.filter((call) => call.includes('docker-compose.stack.yml'));
  const dbDown = (calls) => calls.filter((call) => / -f \S*\/docker-compose\.yml down$/.test(call));

  it('removes the stack, then stops the Nx daemon and the dev database, without Nx in between', () => {
    const { status, calls, stderr } = teardown();
    expect(status, stderr).toBe(0);
    expect(stackDown(calls)).toEqual([
      expect.stringMatching(/^docker compose -p \S+-stack -f \S+ down --volumes --rmi local/),
    ]);
    expect(calls).toContainEqual(
      expect.stringMatching(/^docker image prune --force --filter label=dev-checkout\.root=/),
    );
    expect(calls.filter((call) => call.startsWith('nx '))).toEqual(['nx daemon --stop']);
    expect(dbDown(calls)).toHaveLength(1);
  }, 30_000);

  it('still stops the dev database when removing the stack fails, and fails with it', () => {
    const { status, calls } = teardown({ failing: '*docker-compose.stack.yml*' });
    expect(status).toBe(3);
    expect(stackDown(calls)).toHaveLength(1);
    expect(dbDown(calls)).toHaveLength(1);
  }, 30_000);

  it('leaves a stack this checkout does not own', () => {
    const { status, stdout, calls } = teardown({ env: { STACK_PROJECT: 'theirs-stack' } });
    expect(status).toBe(0);
    expect(stdout).toContain('theirs-stack is not this checkout’s own stack');
    // the dev database's `down` is the only Docker call
    expect(calls.filter((call) => call.startsWith('docker '))).toEqual(dbDown(calls));
    expect(dbDown(calls)).toHaveLength(1);
  }, 30_000);

  it('succeeds when Docker does not run', () => {
    const { status, stdout, calls } = teardown({
      failing: '*',
      message:
        'Cannot connect to the Docker daemon at unix:///nope.sock. Is the docker daemon running?',
    });
    expect(status).toBe(0);
    expect(stdout).toContain('[stack-down] Docker is not running: no stack to remove');
    expect(stackDown(calls)).toHaveLength(1);
    expect(dbDown(calls)).toHaveLength(1);
  }, 30_000);

  it('runs the same script as `pnpm nx run web-e2e:stack-down`', () => {
    const { scripts } = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    const e2e = JSON.parse(readFileSync(join(REPO, 'apps/web-e2e/package.json'), 'utf8'));
    const { command } = e2e.nx.targets['stack-down'];
    expect(command).toBe('node tools/stack-down.mjs');
    expect(scripts.teardown.startsWith(`${command}; s=$?;`)).toBe(true);
  });
});
