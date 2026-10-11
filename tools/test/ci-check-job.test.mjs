// CI's `pnpm check` job (.github/workflows/ci.yml): its `Start Postgres` step, run as Actions runs
// it (`bash -e`) with a fake `pnpm` first on PATH, which logs each call and answers `nx show
// projects` as each test scripts it. tools:test's inputs include the workflows, so a change to
// the step re-runs these.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'ci-check-job-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** The `run: |` script of the check job's `Start Postgres` step. */
function startPostgres() {
  const text = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
  const at = text.indexOf('      - name: Start Postgres\n');
  expect(at).toBeGreaterThan(0);
  const step = text.slice(at, text.indexOf('\n      - ', at + 1));
  const script = /\n {8}run: \|\n((?: {10}.*\n)+)/.exec(step)?.[1];
  expect(script).toBeTruthy();
  return script.replaceAll(/^ {10}/gm, '');
}

/** The step with a pnpm whose `nx …` prints `answer` and exits with `status`: what it called. */
function runStep(answer, status = 0) {
  const bin = mkdtempSync(join(tmp, 'bin-'));
  const log = join(bin, 'pnpm.log');
  writeFileSync(
    join(bin, 'pnpm'),
    `#!/bin/sh\necho "$*" >> "${log}"\nif [ "$1" = nx ]; then echo '${answer}'; exit ${status}; fi\n`,
  );
  chmodSync(join(bin, 'pnpm'), 0o755);
  const res = spawnSync('bash', ['-e', '-c', startPostgres()], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  return { ...res, calls };
}

const AFFECTED = 'nx show projects --affected --projects tag:needs-db --json';

describe("CI's Start Postgres step", () => {
  it('starts Postgres only when a project whose tests use it is affected', () => {
    // a docs-only change, say: nothing pulls the image
    const none = runStep('[]');
    expect(none.status, none.stderr).toBe(0);
    expect(none.calls).toEqual([AFFECTED]);
    expect(none.stdout).toContain('::notice::no project that needs the database is affected');
    const some = runStep('["db","core","api"]');
    expect(some.status, some.stderr).toBe(0);
    expect(some.calls).toEqual([AFFECTED, 'db:up']);
  });

  it('fails, rather than skips the server, when Nx cannot say what is affected', () => {
    const broken = runStep('', 1);
    expect(broken.status).not.toBe(0);
    expect(broken.calls).toEqual([AFFECTED]);
  });
});
