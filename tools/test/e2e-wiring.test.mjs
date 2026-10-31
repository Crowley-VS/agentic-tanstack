// The e2e wiring across projects, which no single project's tests see: apps/web-e2e's Playwright
// config and the api and web serve-e2e targets it starts. tools:test's inputs include every
// package.json and playwright config, so a change to any of them re-runs these tests.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, matchesGlob, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeBin } from '../lib/bin.mjs';
import { makeRepo } from './helpers.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const serveE2e = (app) =>
  JSON.parse(readFileSync(join(REPO, 'apps', app, 'package.json'), 'utf8')).nx.targets['serve-e2e'];
const serveE2eEnv = (app) => serveE2e(app).options.env;

const CONFIG = pathToFileURL(join(REPO, 'apps/web-e2e/playwright.config.mts')).href;
let fresh = 0;
/**
 * playwright.config.mts evaluated afresh with `env` (a query string: not the cached module), as
 * Playwright loads it in a task (NX_TASK_TARGET_TARGET) or Nx while it infers the targets (unset).
 */
async function loadConfig(env) {
  const unset = ['NX_TASK_TARGET_TARGET', 'BASE_URL', 'API_URL', 'E2E_SEEDED', 'E2E_REQUIRE_STACK'];
  for (const key of unset) vi.stubEnv(key, '');
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return (await import(`${CONFIG}?env-${++fresh}`)).default;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  it('runs the e2e API on the e2e database and port, and reseeds that database first', () => {
    const target = serveE2e('api');
    // the script dev-ports runs, with a fake `node` that prints what the real one would get
    const script = /sh -c '([^']*)'/.exec(target.command)?.[1] ?? '';
    const bin = mkdtempSync(join(tmpdir(), 'api-serve-e2e-'));
    try {
      writeFileSync(join(bin, 'node'), '#!/bin/sh\necho "$* $DATABASE_URL $PORT"\n');
      chmodSync(join(bin, 'node'), 0o755);
      // what dev-ports sets: the dev database too, which the e2e API must never use
      const env = { PATH: `${bin}:${process.env.PATH ?? ''}`, DATABASE_URL: 'dev' };
      Object.assign(env, { E2E_DATABASE_URL: 'e2e', API_E2E_PORT: '4100' });
      expect(execFileSync('sh', ['-c', script], { env, encoding: 'utf8' }).trim()).toBe(
        'dist/main.mjs e2e 4100',
      );
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
    // every e2e run starts from the seed: the API waits for db:db-seed-e2e
    expect(target.dependsOn).toContainEqual({ projects: ['db'], target: 'db-seed-e2e' });
  });

  it('never opens the HTML report, whose server would keep a failed e2e task running', async () => {
    const playwright = await loadConfig({});
    expect(playwright.reporter).toContainEqual([
      'html',
      expect.objectContaining({ open: 'never' }),
    ]);
  });

  it('annotates GitHub once per failure: not again when CI merges the reports (PW_MERGE)', async () => {
    const reporters = async (env) => (await loadConfig({ CI: '', PW_MERGE: '', ...env })).reporter;
    expect(await reporters({ CI: 'true' })).toContainEqual(['github']);
    const merge = await reporters({ CI: 'true', PW_MERGE: '1' });
    expect(merge).not.toContainEqual(['github']);
    expect(merge).toContainEqual(['list']);
    expect(readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8')).toMatch(
      /run: pnpm nx run web-e2e:e2e-ci--merge-reports .*\n\s+env:\n\s+PW_MERGE: '1'/,
    );
  });

  it('in BASE_URL mode, starts no server and tests the stack it names (e2e-base-url)', async () => {
    const playwright = await loadConfig({
      NX_TASK_TARGET_TARGET: 'e2e-base-url',
      BASE_URL: 'http://127.0.0.1:9/',
      E2E_SEEDED: '1',
    });
    expect(playwright.webServer).toBeUndefined();
    expect(playwright.use).toMatchObject({
      baseURL: 'http://127.0.0.1:9',
      apiURL: undefined,
      seeded: true,
    });
    // what that stack offers: its API when API_URL names it; the seed only with E2E_SEEDED=1
    const deploy = await loadConfig({
      NX_TASK_TARGET_TARGET: 'e2e-base-url',
      BASE_URL: 'https://notes.example',
      API_URL: 'http://127.0.0.1:8/',
    });
    expect(deploy.use).toMatchObject({ apiURL: 'http://127.0.0.1:8', seeded: false });
    // and the e2e servers' own, otherwise
    expect((await loadConfig({})).use).toMatchObject({
      baseURL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      apiURL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      seeded: true,
    });
  });

  it('refuses the wrong mode in a task, but never while Nx infers the targets', async () => {
    await expect(loadConfig({ NX_TASK_TARGET_TARGET: 'e2e-base-url' })).rejects.toThrow(
      'web-e2e:e2e-base-url needs BASE_URL',
    );
    for (const target of ['e2e', 'e2e-ci--src/harness.spec.ts'])
      await expect(
        loadConfig({ NX_TASK_TARGET_TARGET: target, BASE_URL: 'http://127.0.0.1:9' }),
        target,
      ).rejects.toThrow('BASE_URL is for web-e2e:e2e-base-url');
    // E2E_REQUIRE_STACK=1 (CI's docker job, e2e-stack): a stack without the seed fails the run
    await expect(
      loadConfig({
        NX_TASK_TARGET_TARGET: 'e2e-base-url',
        BASE_URL: 'http://127.0.0.1:9',
        E2E_REQUIRE_STACK: '1',
      }),
    ).rejects.toThrow('E2E_REQUIRE_STACK=1: the stack must hold the e2e seed');
    // inference: every command builds the graph, the images' builds too
    const inferred = await loadConfig({ BASE_URL: 'http://127.0.0.1:9', E2E_REQUIRE_STACK: '1' });
    expect(inferred.webServer).toBeUndefined();
  });

  it('starts one api and one web server for every e2e task, and lets the tasks run in parallel', () => {
    const [cmd = '', ...pre] = nodeBin(REPO, 'nx') ?? [];
    const { targets } = JSON.parse(
      execFileSync(cmd, [...pre, 'show', 'project', 'web-e2e', '--json'], {
        cwd: REPO,
        // BASE_URL mode infers no servers (the test above): never from the caller's shell
        env: { ...process.env, BASE_URL: undefined },
        encoding: 'utf8',
      }),
    );
    // BASE_URL mode's own targets: always run (a stack changes without a commit); e2e-base-url
    // starts nothing, e2e-stack builds the images first (tools/test/e2e-stack.test.mjs)
    for (const target of ['e2e-base-url', 'e2e-stack'])
      expect(targets[target], target).toMatchObject({ cache: false });
    expect(targets['e2e-base-url'].dependsOn ?? []).toEqual([]);
    const tasks = Object.keys(targets).filter(
      (t) => t === 'e2e' || /^e2e-ci--.*\.spec\.ts$/.test(t),
    );
    // any spec: tools:test does not rerun when a spec is renamed (spec files are not its inputs)
    expect(tasks.filter((t) => t.startsWith('e2e-ci--')).length).toBeGreaterThan(0);
    for (const task of tasks) {
      // what @nx/playwright infers only from the exact webServer entries (playwright.config.mts)
      expect(targets[task].dependsOn, task).toContainEqual({
        projects: ['api', 'web'],
        target: 'serve-e2e',
      });
      expect(targets[task].parallelism, task).not.toBe(false);
      // cached: a new Postgres image or new port logic (dev-ports.mjs) must run the specs again
      expect(targets[task].inputs, task).toContain('dbServer');
      // BASE_URL set by mistake must not replay a local run's result (the config then refuses it)
      expect(targets[task].inputs, task).toContainEqual({ env: 'BASE_URL' });
    }
  }, 60_000);

  // @nx/playwright caches the targets it infers, keyed on the project's files and the dotenv files
  // Nx loads into its tasks, never on another untracked file: a port override only reaches the
  // readiness gate from .env.local (dev-ports reads it for that reason). A sandbox workspace whose
  // Playwright config asks dev-ports for its ports, as playwright.config.mts does; no daemon, so the
  // second command gets the plugin's cache from the first
  it('infers the readiness gate again when .env.local moves the e2e ports', () => {
    const devPorts = JSON.stringify(join(REPO, 'tools/dev-ports.mjs'));
    const root = makeRepo({
      'package.json': { name: 'sandbox', private: true },
      'nx.json': { plugins: [{ plugin: '@nx/playwright/plugin', options: { targetName: 'e2e' } }] },
      '.gitignore': '.env.local\n.nx/\nnode_modules\n',
      'apps/e/package.json': { name: 'e', nx: { targets: { serve: { command: 'true' } } } },
      'apps/e/playwright.config.mjs': [
        "import { execFileSync } from 'node:child_process';",
        `const json = execFileSync(process.execPath, [${devPorts}, '--json'], { encoding: 'utf8' });`,
        'const { webE2e } = JSON.parse(json).ports;',
        "const server = { command: 'pnpm nx run e:serve', reuseExistingServer: true };",
        'export default { webServer: [{ ...server, url: `http://127.0.0.1:${webE2e}/health` }] };',
      ].join('\n'),
    });
    symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'), 'junction');
    // neither this task's Nx variables nor a port override of the checkout running the test
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^NX_|_PORT$/.test(key)),
    );
    Object.assign(env, { NX_DAEMON: 'false', NX_NO_CLOUD: 'true' });
    const [cmd = '', ...pre] = nodeBin(REPO, 'nx') ?? [];
    const gate = () =>
      JSON.parse(
        execFileSync(cmd, [...pre, 'show', 'project', 'e', '--json'], {
          cwd: root,
          env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      ).targets['e2e--wait-for-webserver']?.options.servers.map((s) => s.url);
    expect(gate()).toEqual(['http://127.0.0.1:3100/health']);
    writeFileSync(join(root, '.env.local'), 'WEB_E2E_PORT=3110\n');
    expect(gate()).toEqual(['http://127.0.0.1:3110/health']);
  }, 120_000);

  it('gives a spec in a subfolder the same cache inputs (nx.json targetDefaults)', () => {
    const { targetDefaults } = JSON.parse(readFileSync(join(REPO, 'nx.json'), 'utf8'));
    // Nx matches a targetDefaults key against the task name with minimatch, as matchesGlob does:
    // `**` inside a segment is a plain `*` there
    const keys = Object.keys(targetDefaults).filter((key) =>
      targetDefaults[key].inputs?.includes('dbServer'),
    );
    for (const task of ['e2e-ci--src/a.spec.ts', 'e2e-ci--src/notes/a.spec.ts'])
      expect(
        keys.some((key) => matchesGlob(task, key)),
        task,
      ).toBe(true);
  });
});
