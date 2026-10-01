// The stack's skills point agents at repo files, Nx targets and pnpm scripts: each one they name
// must exist, so a rename fails here instead of sending the next agent to a missing file.
// tools:test's inputs include .agents/skills and every package.json and project.json (targets,
// scripts); a file renamed elsewhere fails this test the next time tools:test runs uncached.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeBin } from '../lib/bin.mjs';

const REPO = resolve(import.meta.dirname, '../..');
/** Stack-owned skills checked here (the kit's review-loop names files of the user's own setup). */
const SKILLS = ['add-feature'];
/** Gitignored, made by the agent that follows the skill (plans and scratch notes). */
const LOCAL_ONLY = '.agents/ignore/';

/** Every file on disk git would commit (tracked or new, not ignored), and each directory of one. */
function repoEntries() {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: REPO,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => file && existsSync(join(REPO, file))); // a tracked file moved away is gone
  const entries = new Set(files);
  for (const file of files)
    for (let dir = dirname(file); dir !== '.'; dir = dirname(dir)) entries.add(dir);
  return [...entries];
}

/**
 * The code spans that name a file or directory: no spaces, quotes or calls, and a `/` or a file
 * extension. Leaves out `@scope/package` specifiers, routes (`/health`), URLs and `./module`s.
 */
function pathSpans(markdown) {
  return [...markdown.matchAll(/`([^`\n]+)`/g)]
    .map((m) => m[1])
    .filter((s) => !/[\s'"()={}:]/.test(s) && !/^[@/-]|^\.\//.test(s))
    .filter((s) => s.includes('/') || /\.(ts|tsx|mts|mjs|js|json|md|sql|graphql|ya?ml)$/.test(s));
}

/**
 * A span as a pattern over repo paths: `*` within a segment, `**` across them, `<placeholder>`
 * and `YYYY-MM-DD` for one segment's part. A span that does not start at the repo root
 * (`notes.test.ts`, `src/gql`) matches the end of a path.
 */
function pathPattern(span, topLevel) {
  const fromRoot = topLevel.includes(span.split('/')[0]);
  const body = span
    .replace(/\/$/, '')
    .split(/(\*\*|\*|<[^>]+>|YYYY-MM-DD)/)
    .map((part) =>
      part === '**'
        ? '.*'
        : part === '*' || part.startsWith('<')
          ? '[^/]+'
          : part === 'YYYY-MM-DD'
            ? '\\d{4}-\\d{2}-\\d{2}'
            : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`${fromRoot ? '^' : '(^|/)'}${body}$`);
}

/** Every Nx project's targets, from one `nx graph --print`. */
function nxTargets() {
  const [cmd = '', ...pre] = nodeBin(REPO, 'nx') ?? [];
  const { graph } = JSON.parse(
    execFileSync(cmd, [...pre, 'graph', '--print'], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  return Object.fromEntries(
    Object.entries(graph.nodes).map(([name, node]) => [name, Object.keys(node.data.targets ?? {})]),
  );
}

describe('pathSpans / pathPattern', () => {
  it('picks the spans that name files or directories, never commands, code, routes or URLs', () => {
    const md =
      'Edit `apps/web/src/a.ts` and `notes.test.ts` (`src/gql`, `*.browser.test.tsx`), not ' +
      '`pnpm nx run web:codegen`, `t.relation`, `noteKeys.lists()`, `@acme/db/testing`, ' +
      '`/health`, `https://x.co/`, `./fixtures`, `type="url"` or `\'https://x.co/\' + v`.';
    expect(pathSpans(md)).toEqual([
      'apps/web/src/a.ts',
      'notes.test.ts',
      'src/gql',
      '*.browser.test.tsx',
    ]);
  });

  it('matches from the root only for a span that starts with a top-level entry', () => {
    const top = ['apps', 'packages', '.agents'];
    const migration = pathPattern('packages/db/migrations/<timestamp>_<what>/migration.sql', top);
    expect(migration.test('packages/db/migrations/20260101_init/migration.sql')).toBe(true);
    expect(migration.test('packages/db/migrations/x/y/migration.sql')).toBe(false);
    expect(pathPattern('src/gql', top).test('apps/web/src/gql')).toBe(true);
    expect(pathPattern('src/gql', top).test('apps/web/mysrc/gql')).toBe(false);
    expect(pathPattern('apps/web/src/gql/**', top).test('apps/web/src/gql/a/b.ts')).toBe(true);
    expect(pathPattern('apps/x.ts', top).test('other/apps/x.ts')).toBe(false);
    expect(pathPattern('*.browser.test.tsx', top).test('a/note-form.browser.test.tsx')).toBe(true);
  });
});

describe.each(SKILLS)('skill %s', (skill) => {
  const text = readFileSync(join(REPO, '.agents/skills', skill, 'SKILL.md'), 'utf8');

  it('names only repo paths that exist', () => {
    const entries = repoEntries();
    const topLevel = [...new Set(entries.map((e) => e.split('/')[0]))];
    const spans = pathSpans(text).filter((s) => !s.startsWith(LOCAL_ONLY));
    expect(spans.length).toBeGreaterThan(20); // the extraction still finds the skill's paths
    const missing = spans.filter((s) => !entries.some((e) => pathPattern(s, topLevel).test(e)));
    expect(missing, 'renamed or deleted: update the skill').toEqual([]);
  });

  it('names only Nx targets and pnpm scripts that exist', () => {
    const targets = nxTargets();
    const named = [
      ...[...text.matchAll(/pnpm nx run ([\w-]+):([\w-]+)/g)].map((m) => [m[1], m[2]]),
      // the `nx <target> <project>` shorthand (`pnpm nx e2e web-e2e`)
      ...[...text.matchAll(/pnpm nx (?!run )([a-z][\w-]*) ([a-z][\w-]*)(?![\w:-])/g)]
        .filter((m) => m[2] in targets)
        .map((m) => [m[2], m[1]]),
    ].map(([project, target]) => `${project}:${target}`);
    expect(named.length).toBeGreaterThan(5);
    const unknown = named.filter((pt) => !targets[pt.split(':')[0]]?.includes(pt.split(':')[1]));
    expect(unknown, 'not a target: `pnpm nx show project <p> --json`').toEqual([]);

    const { scripts } = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    const commands = [...text.matchAll(/\bpnpm ([a-z][\w:-]*)/g)].map((m) => m[1]);
    expect(commands).toContain('db:seed');
    // `pnpm nx` and `pnpm exec` are not scripts: the nx binary and pnpm's own command
    const notScripts = commands.filter((c) => !(c in scripts) && c !== 'nx' && c !== 'exec');
    expect(notScripts, 'not a root package.json script').toEqual([]);
  });
});
