import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// Component tests in real Chromium (Vitest Browser Mode): `pnpm nx run web:test-browser`.
// Headless unless HEADED=1 (headed needs the full browser: `pnpm exec playwright install chromium`).
// Not named vitest.config.*, so @nx/vitest's inferred `test` target (node tests) never loads it.
export default defineConfig({
  plugins: [react()],
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
  },
  test: {
    name: 'web-browser',
    include: ['src/**/*.browser.test.tsx'],
    // failure screenshots and attachments go to the gitignored test-output/, not next to the tests
    attachmentsDir: 'test-output/vitest-attachments',
    // without actionTimeout, expect.element waits out the whole test timeout (15 s) before failing
    expect: { poll: { timeout: 3000 } },
    browser: {
      enabled: true,
      provider: playwright({ actionTimeout: 5_000 }),
      headless: process.env.HEADED !== '1',
      instances: [{ browser: 'chromium' }],
      screenshotDirectory: 'test-output/browser-screenshots',
    },
  },
});
