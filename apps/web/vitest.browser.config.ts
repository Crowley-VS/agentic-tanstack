import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Component tests in real Chromium (Vitest Browser Mode): `pnpm nx run web:test-browser`.
// Headless unless HEADED=1 (headed needs the full browser: `pnpm exec playwright install chromium`).
// Not named vitest.config.*, so @nx/vitest's inferred `test` target (node tests) never loads it.
export default defineConfig({
  // as the app's client (vite.config.ts): Tailwind, and workspace packages from source
  plugins: [tailwindcss(), react()],
  resolve: { conditions: ['@acme/source', ...defaultClientConditions] },
  // pre-bundle up front: a dependency discovered mid-run makes Vite reload the page and the run
  // flaky ("optimized dependencies changed. reloading"): add new ones here when that warning shows
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react/jsx-dev-runtime',
      'vitest-browser-react',
      // @acme/ui's dependencies (not web's own, so resolved from there)
      '@acme/ui > radix-ui',
      '@acme/ui > cn',
      '@acme/ui > class-variance-authority',
    ],
    // server code only: execute()'s server branch reads the page request through it (tests mock
    // execute), and it needs Start's Vite plugin, which tests do not load. Pre-bundled, it fails
    // the run; left out, Vite only logs two harmless "Pre-transform error" lines for it
    // (#tanstack-router-entry, tanstack-start-manifest:v), since no test runs it.
    exclude: ['@tanstack/react-start/server'],
  },
  test: {
    name: 'web-browser',
    include: ['src/**/*.browser.test.{ts,tsx}'],
    // the app's stylesheet on every test page: without it Tailwind classes do nothing, and a
    // `hidden` or disabled-looking element passes toBeVisible()
    setupFiles: ['./src/styles.css'],
    // failure screenshots and attachments go to the gitignored test-output/, not next to the tests
    attachmentsDir: 'test-output/vitest-attachments',
    // expect.element gives up after 3 s, not Vitest's 1 s: room for a busy machine
    expect: { poll: { timeout: 3000 } },
    browser: {
      enabled: true,
      // bounds locator actions (click, fill) and the element lookups behind expect.element:
      // without it, a missing element waits out the whole test timeout (15 s) before failing
      provider: playwright({ actionTimeout: 5_000 }),
      headless: process.env.HEADED !== '1',
      instances: [{ browser: 'chromium' }],
      screenshotDirectory: 'test-output/browser-screenshots',
    },
  },
});
