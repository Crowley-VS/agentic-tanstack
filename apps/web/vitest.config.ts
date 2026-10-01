import { configDefaults, defineConfig } from 'vitest/config';

// Node tests only: a plain Vite config without the Start and Nitro plugins (vite.config.ts is the
// app's, and nx.json keeps @nx/vitest from loading it). Browser tests (`*.browser.test.tsx`) get
// a config of their own.
export default defineConfig({
  test: {
    name: 'web',
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
    exclude: [...configDefaults.exclude, 'src/**/*.browser.test.{ts,tsx}'],
  },
});
