// codegen.ts decides whose graphql() operations get typed, and shipped: gql.ts's documents map is in
// the client bundle, so tests and generated files must stay out.
import { matchesGlob } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../codegen';

const patterns = [config.documents].flat().filter((d): d is string => typeof d === 'string');
const isDocument = (file: string) =>
  patterns.some((p) => !p.startsWith('!') && matchesGlob(file, p)) &&
  !patterns.some((p) => p.startsWith('!') && matchesGlob(file, p.slice(1)));

describe('codegen documents', () => {
  it.each(['src/routes/index.tsx', 'src/lib/notes/queries.ts'])('include %s', (file) => {
    expect(isDocument(file)).toBe(true);
  });

  it.each([
    'src/router.test.ts',
    'src/components/note-form.test.tsx',
    'src/components/note-form.browser.test.tsx',
    'src/gql/graphql.ts',
    'src/routeTree.gen.ts',
  ])('leave out %s', (file) => {
    expect(isDocument(file)).toBe(false);
  });
});
