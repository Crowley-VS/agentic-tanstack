// The e2e wiring across projects, which no single project's tests see: apps/web-e2e's Playwright
// config and the api and web serve-e2e targets it starts. tools:test's inputs include every
// package.json and playwright config, so a change to any of them re-runs these tests.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nodeBin } from '../lib/bin.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const serveE2eEnv = (app) =>
  JSON.parse(readFileSync(join(REPO, 'apps', app, 'package.json'), 'utf8')).nx.targets['serve-e2e']
    .options.env;

describe('e2e wiring', () => {
  it('runs the e2e API in production mode, on loopback, writable, with the e2e BFF’s secret', () => {
    const api = serveE2eEnv('api');
    // production: the only mode in which the API enforces the secret (harness.spec checks the 401)
    expect(api).toMatchObject({
      NODE_ENV: 'production',
      LISTEN_HOST: '127.0.0.1',
      READ_ONLY: 'false',
    });
    expect(api.INTERNAL_API_SECRET.length).toBeGreaterThanOrEqual(32); // InternalApiSecret's minimum
    // two copies of one fixed test value (options.env cannot share one): a change to one breaks e2e
    expect(serveE2eEnv('web').INTERNAL_API_SECRET).toBe(api.INTERNAL_API_SECRET);
  });

  it('never opens the HTML report, whose server would keep a failed e2e task running', async () => {
    const config = join(REPO, 'apps/web-e2e/playwright.config.mts');
    const { default: playwright } = await import(pathToFileURL(config).href);
    expect(playwright.reporter).toContainEqual([
      'html',
      expect.objectContaining({ open: 'never' }),
    ]);
  });

  it('starts one api and one web server for every e2e task, and lets the tasks run in parallel', () => {
    const [cmd = '', ...pre] = nodeBin(REPO, 'nx') ?? [];
    const { targets } = JSON.parse(
      execFileSync(cmd, [...pre, 'show', 'project', 'web-e2e', '--json'], {
        cwd: REPO,
        encoding: 'utf8',
      }),
    );
    const tasks = Object.keys(targets).filter(
      (t) => t === 'e2e' || /^e2e-ci--.*\.spec\.ts$/.test(t),
    );
    expect(tasks).toContain('e2e-ci--src/harness.spec.ts');
    for (const task of tasks) {
      // what @nx/playwright infers only from the exact webServer entries (playwright.config.mts)
      expect(targets[task].dependsOn, task).toContainEqual({
        projects: ['api', 'web'],
        target: 'serve-e2e',
      });
      expect(targets[task].parallelism, task).not.toBe(false);
      // cached: a new Postgres image or other e2e ports must run the specs again
      expect(targets[task].inputs, task).toContain('dbServer');
    }
  }, 60_000);
});
