import { defineConfig } from 'vitest/config';
import { dbTestConfig } from './src/testing/vitest';

export default defineConfig({
  test: {
    name: 'db',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    ...dbTestConfig(),
  },
});
