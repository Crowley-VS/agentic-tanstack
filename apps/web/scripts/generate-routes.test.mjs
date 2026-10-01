import { readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const globs = pkg.nx.targets['generate-routes'].inputs
  .filter((input) => typeof input === 'string')
  .map((input) => input.replace('{projectRoot}', 'apps/web'));

// Every file routeTree.gen.ts depends on, not only src/routes: Start writes the `Register` footer
// from the router and start entries it finds (src/router.* and src/start.*, with the extensions of
// its resolveEntry), and the generator merges tsr.config.json from the Vite root.
const ENTRY_EXTENSIONS = ['ts', 'js', 'mts', 'mjs', 'tsx', 'jsx'];
const READS = [
  'apps/web/src/routes/index.tsx',
  'apps/web/src/routes/api/nested/deep.ts',
  'apps/web/vite.config.ts',
  'apps/web/tsr.config.json',
  'apps/web/scripts/generate-routes.mjs',
  ...ENTRY_EXTENSIONS.flatMap((ext) => [`apps/web/src/start.${ext}`, `apps/web/src/router.${ext}`]),
];

describe('web:generate-routes cache inputs', () => {
  it.each(READS)('re-run the generator when %s changes, appears or goes away', (file) => {
    expect(globs.some((glob) => matchesGlob(file, glob))).toBe(true);
  });
});
