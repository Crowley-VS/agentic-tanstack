import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'tools',
    environment: 'node',
    include: ['test/**/*.test.mjs'],
    // Many of these tests start real processes (ESLint, nx, git, hooks). A cold start on a loaded
    // CI runner takes several times longer than locally, past Vitest's 5 s default.
    testTimeout: 30_000,
  },
});
