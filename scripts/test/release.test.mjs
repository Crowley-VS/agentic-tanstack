// release-please (release-please-config.json, .release-please-manifest.json and
// .github/workflows/release-please.yml): the template's releases, which docs/maintaining.md
// describes. release-please itself needs the GitHub API; these pin what this repository relies on
// from it. Template-only, like the files they read: bootstrap removes them all.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { oxfmtEntry, TEMPLATE_ONLY } from '../bootstrap.ts';

const REPO = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(join(REPO, path), 'utf8');
const json = (path) => JSON.parse(read(path));

const config = json('release-please-config.json');
const manifest = json('.release-please-manifest.json');
const root = config.packages['.'];

describe('release-please', () => {
  it('releases the repository as one package, tagged vX.Y.Z, its first release 0.1.0', () => {
    expect(Object.keys(config.packages)).toEqual(['.']);
    expect(Object.keys(manifest)).toEqual(['.']);
    expect(root['release-type']).toBe('node');
    expect(root['include-component-in-tag']).toBe(false);
    // release-please reads a manifest version of 0.0.0 as "never released", and would start at
    // 1.0.0 without initial-version
    if (manifest['.'] === '0.0.0') expect(root['initial-version']).toBe('0.1.0');
    // a breaking change before 1.0 bumps the minor
    expect(root['bump-minor-pre-major']).toBe(true);
  });

  it('writes the version everywhere the template records it, and they agree', () => {
    const version = manifest['.'];
    // the node release type writes package.json; bootstrap resets a copy's to 0.0.0
    expect(json('package.json').version).toBe(version);
    expect(root['extra-files']).toContainEqual({
      type: 'json',
      path: 'template.json',
      jsonpath: '$.version',
    });
    expect(json('template.json').version).toBe(version);
  });

  it('owns CHANGELOG.md, which oxfmt leaves in its format and bootstrap removes', () => {
    expect(root['changelog-path']).toBe('CHANGELOG.md');
    expect(TEMPLATE_ONLY).toEqual(expect.arrayContaining(['CHANGELOG.md', '.prettierignore']));
    const ignored = read('.prettierignore')
      .split('\n')
      .filter((line) => line && !line.startsWith('#'));
    expect(ignored).toEqual(['CHANGELOG.md']);

    // an entry as release-please writes it (`*` bullets, two blank lines), which oxfmt would
    // reformat: `pnpm check`'s format gate fails the release PR unless .prettierignore names it
    const dir = mkdtempSync(join(tmpdir(), 'release-changelog-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(
      join(dir, 'CHANGELOG.md'),
      '# Changelog\n\n## [0.1.0](https://example.com/compare/v0.0.0...v0.1.0) (2026-11-02)\n\n\n### Features\n\n* **web:** a feature ([abc1234](https://example.com/commit/abc1234))\n',
    );
    const oxfmt = oxfmtEntry(REPO);
    expect(oxfmt, 'oxfmt is not installed: run `pnpm install`').toBeDefined();
    const check = () =>
      spawnSync(process.execPath, [oxfmt, '--check', '--no-error-on-unmatched-pattern', '.'], {
        cwd: dir,
        encoding: 'utf8',
      }).status;
    expect(check()).toBe(1);
    cpSync(join(REPO, '.prettierignore'), join(dir, '.prettierignore'));
    expect(check()).toBe(0);
  });

  it('finds a version heading in CHANGELOG.md to insert each release above, after the intro', () => {
    // release-please's changelog updater inserts above the first heading like `## 1.2.3` or
    // `## [1.2.3]`; without one it prepends its own `# Changelog` and demotes the file's headings
    // (a second "Changelog" heading). `## 0.0.0`, the manifest's start, is the permanent baseline;
    // an `## [Unreleased]` section would match too and end up below every release.
    const text = read('CHANGELOG.md');
    const first = text.match(/\n##? v?[0-9[][^\n]*/)?.[0].trim();
    expect(first).toBe(`## ${manifest['.']}`);
    expect(text.startsWith('# Changelog\n')).toBe(true);
    expect(text).not.toMatch(/unreleased/i);
  });

  it('runs on main in the template only, as the App when there is one, else GITHUB_TOKEN', () => {
    const text = read('.github/workflows/release-please.yml');
    expect(text).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]\n\n/m);
    expect(text).toMatch(/^permissions: \{\}$/m);
    expect(text).toMatch(/^ {4}if: vars\.TEMPLATE_MAINTENANCE == 'true'$/m);
    // what release-please does with GITHUB_TOKEN, and nothing more
    const permissions = text.match(/^ {4}permissions:\n((?: {6}.*\n)+)/m)?.[1] ?? '';
    expect(
      permissions
        .split('\n')
        .filter(Boolean)
        .map((l) => l.replace(/\s+#.*$/, '').trim()),
    ).toEqual(['contents: write', 'pull-requests: write', 'issues: write']);
    expect(text).toMatch(/^ {8}if: vars\.AUTOMATION_APP_CLIENT_ID != ''$/m);
    expect(text).toContain('token: ${{ steps.app.outputs.token || secrets.GITHUB_TOKEN }}');
    // no checkout: release-please works through the API, and nothing of the repository runs
    expect(text).not.toContain('actions/checkout');
  });
});
