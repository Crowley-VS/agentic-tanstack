import { fileURLToPath } from 'node:url';

/** Vitest settings for a project whose tests use the database (spread into `test: {}`). */
export function dbTestConfig() {
  return {
    globalSetup: [fileURLToPath(new URL('./global-setup.ts', import.meta.url))],
    setupFiles: [fileURLToPath(new URL('./setup-file.ts', import.meta.url))],
    // every file clones its own database; more workers than this mostly contend for the CPU
    maxWorkers: 4,
  };
}
