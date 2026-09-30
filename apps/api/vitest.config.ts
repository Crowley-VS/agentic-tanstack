import { createRequire } from 'node:module';
import { dbTestConfig } from '@acme/db/testing/vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // graphql 16 has no "exports" map: Node (and so Yoga and Pothos, which Vitest leaves to Node)
    // loads its CommonJS build, while Vite would give our source the ESM build. Two GraphQLError
    // classes break Yoga's `instanceof` checks (a ValidationError would be masked). Use Node's.
    alias: [{ find: /^graphql$/, replacement: createRequire(import.meta.url).resolve('graphql') }],
  },
  test: {
    name: 'api',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    ...dbTestConfig(),
  },
});
