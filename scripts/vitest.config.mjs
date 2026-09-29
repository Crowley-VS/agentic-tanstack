import { devNull } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'scripts',
    environment: 'node',
    include: ['test/**/*.test.mjs'],
    testTimeout: 60_000,
    // git in the tests (and in bootstrap) ignores the developer's global config (commit signing etc.)
    env: { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' },
  },
});
