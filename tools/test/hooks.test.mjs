import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitAll, makeRepo, runHook, tempDir, writeFile } from './helpers.mjs';

const GUARD = resolve(import.meta.dirname, '../agent-hooks/guard-paths.mjs');
const FORMAT = resolve(import.meta.dirname, '../agent-hooks/format.mjs');

const manifest = {
  artifacts: [
    {
      id: 'graphql-types',
      paths: ['apps/web/src/gql/**'],
      regen: 'pnpm nx run web:codegen',
      description: 'client types generated from the GraphQL schema',
    },
    {
      id: 'migrations',
      paths: ['packages/db/migrations/**'],
      regen: 'pnpm nx run db:db-generate',
      protect: 'tracked',
    },
  ],
};

function repo() {
  const root = makeRepo({
    '.agents/generated.json': manifest,
    'apps/web/src/gql/graphql.ts': 'export {};\n',
    'apps/web/src/main.ts': 'export {};\n',
    'packages/db/migrations/0001_init/migration.sql': 'select 1;\n',
  });
  commitAll(root);
  return root;
}

const edit = (root, rel, cwd = root) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  cwd,
  tool_input: { file_path: join(root, rel), old_string: 'a', new_string: 'b' },
});

const relativeEdit = (cwd) => ({
  tool_name: 'Edit',
  cwd,
  tool_input: { file_path: 'apps/web/src/gql/graphql.ts' },
});

/** The repo reached through a symlink (a symlinked checkout; macOS's /var → /private/var). */
function linkTo(root) {
  const link = join(tempDir('linked-'), 'repo');
  symlinkSync(root, link, 'dir');
  return link;
}

/** A fake oxfmt package that overwrites the file it is given, so a test can see whether it ran. */
function fakeOxfmt(root) {
  writeFile(root, 'node_modules/oxfmt/package.json', { name: 'oxfmt', bin: { oxfmt: 'cli.mjs' } });
  writeFile(
    root,
    'node_modules/oxfmt/cli.mjs',
    "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv.at(-1), 'formatted\\n');\n",
  );
}

describe('guard-paths hook', () => {
  it('blocks edits to generated files with the regen command (exit 2)', () => {
    const root = repo();
    const res = runHook(GUARD, edit(root, 'apps/web/src/gql/graphql.ts'));
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('apps/web/src/gql/graphql.ts is generated (graphql-types)');
    expect(res.stderr).toContain('pnpm nx run web:codegen');
  });

  it('allows ordinary source files', () => {
    const root = repo();
    expect(runHook(GUARD, edit(root, 'apps/web/src/main.ts')).code).toBe(0);
  });

  it('blocks committed migrations but allows a fresh, untracked one', () => {
    const root = repo();
    expect(runHook(GUARD, edit(root, 'packages/db/migrations/0001_init/migration.sql')).code).toBe(
      2,
    );
    writeFile(root, 'packages/db/migrations/0002_next/migration.sql', 'select 2;\n');
    expect(runHook(GUARD, edit(root, 'packages/db/migrations/0002_next/migration.sql')).code).toBe(
      0,
    );
  });

  it('handles Write to a new file in a generated directory', () => {
    const root = repo();
    const payload = {
      tool_name: 'Write',
      cwd: root,
      tool_input: { file_path: join(root, 'apps/web/src/gql/new-file.ts'), content: 'x' },
    };
    expect(runHook(GUARD, payload).code).toBe(2);
  });

  it('fails closed on malformed input', () => {
    const res = runHook(GUARD, '{not json');
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('refusing the edit');
  });

  it('ignores tool calls without a file path', () => {
    expect(runHook(GUARD, { tool_name: 'Bash', tool_input: { command: 'ls' } }).code).toBe(0);
  });

  it('blocks generated files reached through a symlinked path', () => {
    const root = repo();
    const link = linkTo(root);
    expect(runHook(GUARD, edit(link, 'apps/web/src/gql/graphql.ts')).code).toBe(2);
    expect(runHook(GUARD, edit(link, 'apps/web/src/gql/new-dir/new.ts')).code).toBe(2);
    expect(runHook(GUARD, edit(link, 'apps/web/src/main.ts')).code).toBe(0);
  });

  it('resolves relative paths against the session cwd, including a symlinked one', () => {
    const root = repo();
    const link = linkTo(root);
    expect(runHook(GUARD, relativeEdit(root)).code).toBe(2);
    expect(runHook(GUARD, relativeEdit(link)).code).toBe(2);
  });

  it('fails closed when the manifest is invalid', () => {
    const root = makeRepo({ '.agents/generated.json': '{"artifacts": "nope"}', 'a.ts': 'x' });
    const res = runHook(GUARD, edit(root, 'a.ts'));
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('generated.json is invalid');
  });
});

describe('format hook', () => {
  it('never blocks, even without oxfmt installed or with garbage input', () => {
    const root = repo();
    expect(runHook(FORMAT, edit(root, 'apps/web/src/main.ts')).code).toBe(0);
    expect(runHook(FORMAT, 'garbage').code).toBe(0);
  });

  it('never touches files outside the repository', () => {
    const root = repo();
    const outside = tempDir('not-a-repo-');
    const file = join(outside, 'ugly.ts');
    writeFileSync(file, 'const   x =1\n');
    // give the repo a (fake) oxfmt so only the scope check can prevent formatting
    fakeOxfmt(root);
    const res = runHook(
      FORMAT,
      { tool_name: 'Edit', cwd: root, tool_input: { file_path: file } },
      {
        env: { CLAUDE_PROJECT_DIR: root },
      },
    );
    expect(res.code).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('const   x =1\n');
  });

  it('formats ordinary files but never generated ones', () => {
    const root = repo();
    fakeOxfmt(root); // with oxfmt installed, only the generated-file check can skip a file
    const generated = join(root, 'apps/web/src/gql/graphql.ts');
    const before = readFileSync(generated, 'utf8');
    expect(runHook(FORMAT, edit(root, 'apps/web/src/gql/graphql.ts')).code).toBe(0);
    expect(readFileSync(generated, 'utf8')).toBe(before);
    // positive control: the same setup does format an ordinary file
    expect(runHook(FORMAT, edit(root, 'apps/web/src/main.ts')).code).toBe(0);
    expect(readFileSync(join(root, 'apps/web/src/main.ts'), 'utf8')).toBe('formatted\n');
  });

  it('treats a symlinked path to the repo as inside it', () => {
    const root = repo();
    fakeOxfmt(root);
    const link = linkTo(root);
    const before = readFileSync(join(root, 'apps/web/src/gql/graphql.ts'), 'utf8');
    runHook(FORMAT, edit(link, 'apps/web/src/gql/graphql.ts'));
    expect(readFileSync(join(root, 'apps/web/src/gql/graphql.ts'), 'utf8')).toBe(before);
    runHook(FORMAT, edit(link, 'apps/web/src/main.ts'));
    expect(readFileSync(join(root, 'apps/web/src/main.ts'), 'utf8')).toBe('formatted\n');
  });
});
