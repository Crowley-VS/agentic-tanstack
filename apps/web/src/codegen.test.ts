// codegen.ts decides whose graphql() operations get typed, and shipped: gql.ts's documents map is in
// the client bundle, so tests and generated files must stay out. The web:codegen and
// web:codegen-watch targets (package.json) decide when it runs and what the Nx cache restores.
import { globSync, readFileSync } from 'node:fs';
import { matchesGlob, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../codegen';

const root = fileURLToPath(new URL('..', import.meta.url));
const patterns = [config.documents].flat().filter((d): d is string => typeof d === 'string');
/** Whether globs relative to apps/web (`!` leaves a file out) select `file`. */
const selects = (globs: readonly string[], file: string) =>
  globs.some((g) => !g.startsWith('!') && matchesGlob(file, g)) &&
  !globs.some((g) => g.startsWith('!') && matchesGlob(file, g.slice(1)));
const isDocument = (file: string) => selects(patterns, file);

/** apps/web/package.json: the Nx targets that run codegen. */
type WebPackage = {
  nx: {
    targets: {
      codegen: { inputs: unknown[]; outputs: string[] };
      'codegen-watch': { command: string };
    };
  };
};
const pkg: WebPackage = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const { codegen: target, 'codegen-watch': watchTarget } = pkg.nx.targets;

const INCLUDED = ['src/routes/index.tsx', 'src/lib/notes/queries.ts'];
const LEFT_OUT = [
  'src/router.test.ts',
  'src/components/note-form.test.tsx',
  'src/components/note-form.browser.test.tsx',
  'src/gql/graphql.ts',
  'src/routeTree.gen.ts',
];

describe('codegen documents', () => {
  it.each(INCLUDED)('include %s', (file) => {
    expect(isDocument(file)).toBe(true);
  });

  it.each(LEFT_OUT)('leave out %s', (file) => {
    expect(isDocument(file)).toBe(false);
  });
});

describe('web:codegen', () => {
  it('is re-run when any document changes: its cache inputs select the files codegen reads', () => {
    const inputs = target.inputs
      .filter((i): i is string => typeof i === 'string' && /^!?\{projectRoot\}\/src\//.test(i))
      .map((i) => i.replace('{projectRoot}/', ''));
    // every file in src today, and the probes above: the globs may differ (codegen.ts's
    // browser-test one is redundant), the files they select may not
    const files = [
      ...globSync('src/**', { cwd: root }).map((f) => f.split(sep).join('/')),
      ...INCLUDED,
      ...LEFT_OUT,
    ];
    expect(files.filter((f) => selects(inputs, f))).toEqual(files.filter(isDocument));
  });

  it('declares its files as outputs, never src/gql itself', () => {
    // a cache restore deletes and recreates an output directory, and a running dev server loses
    // its watch on it (later codegen output never reaches the page)
    expect(target.outputs).toEqual(['{projectRoot}/src/gql/*.ts']);
  });

  it('is re-run on save by pnpm dev even where Nx turns its daemon off (CI, Docker)', () => {
    // nx watch needs the daemon; NX_DAEMON=true overrides the CI/Docker default, an explicit
    // NX_DAEMON=false still wins
    expect(watchTarget.command).toMatch(/^NX_DAEMON=\$\{NX_DAEMON:-true\} nx watch /);
  });
});
