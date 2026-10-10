import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'railway-iac',
    environment: 'node',
    include: ['*.test.ts'],
  },
});
