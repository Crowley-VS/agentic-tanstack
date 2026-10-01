// End-to-end tests against the PRODUCTION builds (web's .output, api's dist) on this checkout's e2e
// ports and its own e2e database, recreated and seeded on every run: never the dev servers or data.
//
//   pnpm nx e2e web-e2e            every spec in one Playwright run
//   pnpm nx run web-e2e:e2e-ci     one Nx task per spec file (what CI runs, in parallel)
//
// The two webServer entries are Nx tasks: @nx/playwright turns them into dependencies of `e2e` and
// of every `e2e-ci--<spec>` task, plus a readiness gate on their health URLs, so one Nx run starts
// each server once and every spec shares it. Keep each entry exactly `pnpm nx run <project>:<target>`
// with `reuseExistingServer: true` and no `env` or `wait`: otherwise Nx infers no dependency, and
// runs the e2e-ci tasks one at a time. Their environment lives in the serve-e2e targets.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { nxE2EPreset } from '@nx/playwright/preset';
import { defineConfig, devices } from '@playwright/test';

// This checkout's ports (tools/dev-ports.mjs, the single source; WEB_E2E_PORT / API_E2E_PORT
// override them), asked as a child process: this project may not import `tools`.
const devPorts = join(import.meta.dirname, '../../tools/dev-ports.mjs');
const { ports }: { ports: { webE2e: number; apiE2e: number } } = JSON.parse(
  execFileSync(process.execPath, [devPorts, '--json'], {
    cwd: import.meta.dirname,
    encoding: 'utf8',
  }),
);

// 127.0.0.1, where the serve-e2e targets listen: `localhost` may resolve to ::1 first
const baseURL = `http://127.0.0.1:${ports.webE2e}`;
/** The private API (specs reach it through the web's BFF; `testInfo.config.metadata.apiURL`). */
const apiURL = `http://127.0.0.1:${ports.apiE2e}`;
// `never`: on a failure the html reporter would otherwise serve the report and wait, so the Nx
// task never ends (`pnpm exec playwright show-report` opens it)
const preset = nxE2EPreset(import.meta.dirname, { testDir: './src', openHtmlReport: 'never' });

export default defineConfig({
  ...preset,
  metadata: { apiURL },
  // the preset's html (+ blob on CI, which e2e-ci--merge-reports merges) plus a terminal reporter
  reporter: [...preset.reporter, process.env.CI ? ['github'] : ['list']],
  use: {
    baseURL,
    // kept only for failed tests (CI uploads them): open with `pnpm exec playwright show-trace`
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
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
