import { dbTestConfig } from '@acme/db/testing/vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'core',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    ...dbTestConfig(),
  },
});
