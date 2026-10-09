// End-to-end tests against the PRODUCTION builds (web's .output, api's dist) on this checkout's e2e
// ports and its own e2e database, recreated and seeded on every run: never the dev servers or data.
//
//   pnpm nx e2e web-e2e                 every spec in one Playwright run
//   NX_SKIP_ATOMIZER_VALIDATION=true pnpm nx run web-e2e:e2e-ci --parallel=3
//                                       one Nx task per spec file, 3 at a time (what CI runs;
//                                       without the variable Nx asks for Nx Cloud: docs/e2e.md)
//   pnpm nx run web-e2e:e2e-base-url    every spec against a stack already running at BASE_URL
//   pnpm nx run web-e2e:e2e-stack       every spec against the production images (docs/deployment.md)
//
// The two webServer entries are Nx tasks: @nx/playwright turns them into dependencies of `e2e` and
// of every `e2e-ci--<spec>` task, plus a readiness gate on their health URLs, so one Nx run starts
// each server once and every spec shares it. Keep each entry exactly `pnpm nx run <project>:<target>`
// with `reuseExistingServer: true` and no `env` or `wait`: otherwise Nx infers no dependency, and
// runs the e2e-ci tasks one at a time. Their environment lives in the serve-e2e targets.
//
// Nx also evaluates this file to infer the targets (no NX_TASK_TARGET_TARGET then), for every
// command, the image builds included (docs/deployment.md): the guards below throw only in a task.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { nxE2EPreset } from '@nx/playwright/preset';
import { defineConfig, devices } from '@playwright/test';
import type { StackOptions } from './src/fixtures';

/**
 * BASE_URL mode (`e2e-base-url`): the specs run against a stack that is already up (the
 * production images, a deploy), and nothing is started. API_URL is the private API when it can be
 * reached from here; E2E_SEEDED=1 says the database holds the deterministic seed. Specs that need
 * either skip without it (docs/e2e.md).
 */
const external = process.env.BASE_URL?.replace(/\/+$/, '') || undefined;
// The Nx target running Playwright (unset while Nx infers the targets from this file). Without
// BASE_URL, Playwright would start the e2e servers itself, outside Nx; with it, `e2e` and
// `e2e-ci` would test that stack under their cached names (nx.json hashes BASE_URL for them).
const task = process.env.NX_TASK_TARGET_TARGET;
if (!external && task === 'e2e-base-url')
  throw new Error('web-e2e:e2e-base-url needs BASE_URL, the web server to test (docs/e2e.md)');
if (external && task && task !== 'e2e-base-url')
  throw new Error(
    `BASE_URL is for web-e2e:e2e-base-url: unset it for ${process.env.NX_TASK_TARGET_PROJECT}:${task}`,
  );
const seeded = !external || process.env.E2E_SEEDED === '1';
// A stack prepared for the specs (CI's docker job, e2e-stack): a spec that needs the seed fails
// rather than skips, so a mistyped variable cannot drop those specs from a green run
if (task && process.env.E2E_REQUIRE_STACK === '1' && !seeded)
  throw new Error('E2E_REQUIRE_STACK=1: the stack must hold the e2e seed (E2E_SEEDED=1)');

/**
 * This checkout's e2e ports (tools/dev-ports.mjs, the single source; WEB_E2E_PORT / API_E2E_PORT
 * override them), asked as a child process: this project may not import `tools`.
 */
function e2ePorts(): { webE2e: number; apiE2e: number } {
  const devPorts = join(import.meta.dirname, '../../tools/dev-ports.mjs');
  return JSON.parse(
    execFileSync(process.execPath, [devPorts, '--json'], {
      cwd: import.meta.dirname,
      encoding: 'utf8',
    }),
  ).ports;
}
const ports = external ? undefined : e2ePorts();

// 127.0.0.1, where the serve-e2e targets listen: `localhost` may resolve to ::1 first
const baseURL = external ?? `http://127.0.0.1:${ports?.webE2e}`;
/** The private API (specs reach it through the web's BFF; the `apiURL` fixture). */
const apiURL = external
  ? process.env.API_URL?.replace(/\/+$/, '') || undefined
  : `http://127.0.0.1:${ports?.apiE2e}`;
// `never`: on a failure the html reporter would otherwise serve the report and wait, so the Nx
// task never ends (`pnpm exec playwright show-report` opens it)
const preset = nxE2EPreset(import.meta.dirname, { testDir: './src', openHtmlReport: 'never' });

export default defineConfig<object, StackOptions>({
  ...preset,
  // the preset's html (+ blob on CI, which e2e-ci--merge-reports merges) plus a terminal reporter;
  // the merge reuses this config, so CI's merge step sets PW_MERGE: its failures are annotated once
  reporter: [...preset.reporter, process.env.CI && !process.env.PW_MERGE ? ['github'] : ['list']],
  use: {
    baseURL,
    apiURL,
    seeded,
    // kept only for failed tests (CI uploads them): open with `pnpm exec playwright show-trace`
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: external
    ? undefined
    : [
        {
          command: 'pnpm nx run api:serve-e2e',
          url: `${apiURL}/health`,
          reuseExistingServer: true,
        },
        {
          command: 'pnpm nx run web:serve-e2e',
          url: `${baseURL}/api/health`,
          reuseExistingServer: true,
        },
      ],
});
