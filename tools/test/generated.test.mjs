import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findArtifact, globToRegExp, realpathDeep, toRepoPath } from '../lib/generated.mjs';
import { tempDir } from './helpers.mjs';

describe('globToRegExp', () => {
  it.each([
    ['apps/web/src/gql/**', 'apps/web/src/gql/graphql.ts', true],
    ['apps/web/src/gql/**', 'apps/web/src/gql/nested/x.ts', true],
    ['apps/web/src/gql/**', 'apps/web/src/gqlx/a.ts', false],
    ['**/routeTree.gen.ts', 'apps/web/src/routeTree.gen.ts', true],
    ['**/routeTree.gen.ts', 'routeTree.gen.ts', true],
    ['packages/*/schema.graphql', 'packages/graphql/schema.graphql', true],
    ['packages/*/schema.graphql', 'packages/a/b/schema.graphql', false],
    ['file?.txt', 'file1.txt', true],
    ['a.b', 'axb', false],
  ])('%s matches %s → %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });
});

describe('findArtifact / toRepoPath', () => {
  const manifest = {
    artifacts: [{ id: 'gql', paths: ['apps/web/src/gql/**'], regen: 'pnpm nx run web:codegen' }],
  };

  it('finds the artifact owning a path', () => {
    expect(findArtifact(manifest, 'apps/web/src/gql/graphql.ts')?.id).toBe('gql');
    expect(findArtifact(manifest, 'apps/web/src/main.ts')).toBeUndefined();
  });

  it('never matches paths outside the repo', () => {
    expect(findArtifact(manifest, '../other/apps/web/src/gql/x.ts')).toBeUndefined();
  });

  it('normalizes absolute and relative paths to POSIX repo paths', () => {
    expect(toRepoPath('/repo', '/repo/apps/web/x.ts')).toBe('apps/web/x.ts');
    expect(toRepoPath('/repo', 'x.ts', '/repo/apps/web')).toBe('apps/web/x.ts');
  });

  it('resolves symlinks on both sides, even for files that do not exist yet', () => {
    const real = join(tempDir(), 'repo');
    mkdirSync(join(real, 'apps/web'), { recursive: true });
    const link = join(tempDir(), 'link');
    symlinkSync(real, link, 'dir');
    expect(toRepoPath(realpathDeep(real), join(link, 'apps/web/x.ts'))).toBe('apps/web/x.ts');
    expect(toRepoPath(link, join(real, 'apps/web/new/dir/x.ts'))).toBe('apps/web/new/dir/x.ts');
    expect(toRepoPath(realpathDeep(real), 'apps/web/x.ts', link)).toBe('apps/web/x.ts');
  });

  it('matches case-insensitively when asked (macOS and Windows default)', () => {
    expect(findArtifact(manifest, 'Apps/Web/src/GQL/x.ts', { ignoreCase: true })?.id).toBe('gql');
    expect(findArtifact(manifest, 'Apps/Web/src/GQL/x.ts', { ignoreCase: false })).toBeUndefined();
  });
});
