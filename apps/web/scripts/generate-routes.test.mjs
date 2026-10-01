import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

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

// router.tsx imports routeTree.gen.ts: without generate-routes first, these targets read the
// committed tree, not the route files on disk
describe('targets that read the route tree', () => {
  it.each(['typecheck', 'lint', 'test', 'build'])('web:%s runs generate-routes first', (target) => {
    expect(pkg.nx.targets[target].dependsOn).toContain('generate-routes');
  });
});

describe('generate-routes.mjs', () => {
  const web = fileURLToPath(new URL('..', import.meta.url));
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  /** A minimal copy of the app with these route files; under apps/web, so its imports resolve. */
  function app(routes) {
    mkdirSync(join(web, 'test-output'), { recursive: true });
    const dir = mkdtempSync(join(web, 'test-output', 'generate-routes-'));
    dirs.push(dir);
    copyFileSync(join(web, 'vite.config.ts'), join(dir, 'vite.config.ts'));
    const files = { 'src/router.tsx': 'export function getRouter() {}\n', ...routes };
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
    return dir;
  }
  const run = (dir) =>
    spawnSync(process.execPath, [join(web, 'scripts/generate-routes.mjs'), dir], {
      encoding: 'utf8',
    });
  const ROOT = {
    'src/routes/__root.tsx':
      "import { createRootRoute } from '@tanstack/react-router';\nexport const Route = createRootRoute();\n",
  };

  it('writes the route tree', () => {
    const dir = app(ROOT);
    const res = run(dir);
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(join(dir, 'src/routeTree.gen.ts'))).toBe(true);
  });

  it('fails when a route file is broken (the generator only logs it)', () => {
    const dir = app({
      ...ROOT,
      'src/routes/broken.tsx': 'export const Route = createFileRoute(\n',
    });
    const res = run(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('broken.tsx');
  });
});
