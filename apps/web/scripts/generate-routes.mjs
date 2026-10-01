// Regenerate src/routeTree.gen.ts without a dev server or a build: resolving the Vite config runs
// TanStack Start's route generator (its configResolved hook), exactly as `vite dev` and
// `vite build` do, Start's `Register` footer included (`tsr generate` from @tanstack/router-cli
// omits that footer, so its output would never match).
import { fileURLToPath } from 'node:url';
import { resolveConfig } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
// The generator writes a temp file under <cwd>/.tanstack/tmp and renames it into src/: same disk.
process.chdir(root);
// The generator logs a failure and carries on (a dev server must survive a broken route file);
// here a failure must fail the command.
const logError = console.error;
console.error = (...args) => {
  process.exitCode = 1;
  logError(...args);
};
await resolveConfig({ root, logLevel: 'warn' }, 'build');
