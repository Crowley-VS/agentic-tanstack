import { readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check } from '../agents.mjs';
import {
  applyRewrites,
  findPackage,
  loadVendorManifest,
  notice,
  replaceSection,
  setFrontmatter,
  update,
  vendorProblems,
} from '../vendor-skills.mjs';
import { makeRepo, tempDir, writeFile } from './helpers.mjs';

const UPSTREAM = [
  '---',
  'name: demo',
  'description: Upstream description.',
  'allowed-tools: Bash(demo-cli:*) Bash(npx:*)',
  '---',
  '',
  '# Demo',
  '',
  'Run `demo-cli start` to begin.',
  '',
  '## Install',
  '',
  'npm install -g demo-cli@latest',
  '',
  '## Usage',
  '',
  '```bash',
  'demo-cli start',
  '# a comment, not a heading',
  '```',
  '',
].join('\n');

const REWRITES = [
  { frontmatter: 'allowed-tools', with: 'Bash(pnpm exec demo cli *)' },
  { pattern: '(?<![\\w./-])demo-cli(?= )', with: 'pnpm exec demo cli' },
  { section: '## Install', with: ['## Install', '', 'Pinned: `pnpm exec demo cli`.'] },
];

/** A repo with one vendored skill (`demo`) of package `demo-pkg`, installed at `version`. */
function vendorRepo({ version = '1.0.0', upstream = UPSTREAM, rewrites = REWRITES } = {}) {
  const root = makeRepo({
    '.agents/generated.json': {
      artifacts: [
        {
          id: 'vendored-skills',
          paths: ['.agents/skills/demo/**'],
          regen: 'node tools/vendor-skills.mjs update',
        },
      ],
    },
    '.agents/vendor.json': {
      packages: {
        'demo-pkg': { version: '1.0.0', license: 'MIT', licenseFiles: ['LICENSE'] },
      },
      skills: {
        demo: { package: 'demo-pkg', file: 'skills/demo/SKILL.md', sha256: '', rewrites },
      },
    },
  });
  install(root, { version, upstream });
  return root;
}

function install(root, { version = '1.0.0', upstream = UPSTREAM, license = 'MIT License\n' } = {}) {
  writeFile(root, 'node_modules/demo-pkg/package.json', { name: 'demo-pkg', version });
  writeFile(root, 'node_modules/demo-pkg/skills/demo/SKILL.md', upstream);
  writeFile(root, 'node_modules/demo-pkg/LICENSE', license);
}

const vendored = (root) => readFileSync(join(root, '.agents/skills/demo/SKILL.md'), 'utf8');
/** update, failing the test on any problem. */
function updated(root) {
  const res = update(root, { oxfmt: undefined });
  expect(res.problems).toEqual([]);
  return res;
}

describe('rewrites', () => {
  it('replaces a section up to the next heading of its level, never at a # in fenced code', () => {
    const text = '# T\n\n## A\n\n```sh\n## not a heading\n```\n\n### A.1\n\nx\n\n## B\n\ny\n';
    expect(replaceSection(text, '## A', '## A\n\nnew')).toBe('# T\n\n## A\n\nnew\n\n## B\n\ny\n');
    expect(replaceSection(text, '## A', '')).toBe('# T\n\n## B\n\ny\n');
    // the last section runs to the end
    expect(replaceSection(text, '## B', '## B\n\nz')).toBe(`${text.split('## B')[0]}## B\n\nz\n`);
    expect(replaceSection(text, '## Missing', 'x')).toBeUndefined();
    expect(replaceSection(text, '## not a heading', 'x')).toBeUndefined();
  });

  it('sets a one-line frontmatter key, a folded one included, or adds it', () => {
    const text = '---\nname: x\ndescription: >\n  long\n  text\nmetadata:\n  v: 1\n---\n# x\n';
    expect(setFrontmatter(text, 'description', "it's short")).toBe(
      "---\nname: x\ndescription: 'it''s short'\nmetadata:\n  v: 1\n---\n# x\n",
    );
    expect(setFrontmatter(text, 'license', 'MIT')).toContain("  v: 1\nlicense: 'MIT'\n---\n");
    expect(setFrontmatter('# no frontmatter\n', 'name', 'x')).toBeUndefined();
  });

  it('applies replace, pattern, section and frontmatter rewrites in order', () => {
    const { text, problems } = applyRewrites(UPSTREAM, [
      ...REWRITES,
      { replace: 'Run `', with: ['Then', 'run `$&'] }, // `with` lines; `$&` stays literal
    ]);
    expect(problems).toEqual([]);
    expect(text).toContain("allowed-tools: 'Bash(pnpm exec demo cli *)'\n");
    expect(text).toContain('Then\nrun `$&pnpm exec demo cli start` to begin.');
    expect(text).toContain('```bash\npnpm exec demo cli start\n# a comment, not a heading\n```');
    expect(text).toContain('## Install\n\nPinned: `pnpm exec demo cli`.\n\n## Usage');
    expect(text).not.toContain('npm install');
  });

  it('reports each rewrite that changes nothing: upstream changed under it', () => {
    const { text, problems } = applyRewrites(UPSTREAM, [
      { replace: 'gone text', with: 'x' },
      { section: '## Gone', with: 'x' },
      { frontmatter: 'name', with: 'demo' }, // already upstream's value: an obsolete rewrite
      { pattern: '(', with: 'x' },
      { replace: 'Demo', with: 'Demo!' },
    ]);
    expect(problems).toEqual([
      expect.stringMatching(/^rewrite 1 \(replace "gone text"\) changes nothing/),
      expect.stringMatching(/^rewrite 2 \(section "## Gone"\) changes nothing/),
      expect.stringMatching(/^rewrite 3 \(frontmatter "name"\) changes nothing/),
      expect.stringMatching(/^rewrite 4 of the upstream text is invalid/),
    ]);
    expect(text).toContain('# Demo!'); // the others still apply
  });
});

describe('packages', () => {
  it('follows `from` and the `via` dependency chain through a pnpm layout', () => {
    const root = tempDir();
    const store = 'node_modules/.pnpm/outer@1.0.0/node_modules';
    writeFile(root, `${store}/outer/package.json`, { name: 'outer', version: '1.0.0' });
    writeFile(root, `${store}/inner/package.json`, { name: 'inner', version: '2.0.0' });
    writeFile(root, 'packages/app/package.json', { name: 'app' });
    writeFile(root, 'packages/app/node_modules/.keep', '');
    symlinkSync(join(root, store, 'outer'), join(root, 'packages/app/node_modules/outer'), 'dir');
    // inner is no dependency of app: only outer's
    expect(findPackage(root, 'inner', { from: 'packages/app' })).toBeUndefined();
    expect(findPackage(root, 'inner', { from: 'packages/app', via: ['outer'] })).toMatch(
      /\.pnpm\/outer@1\.0\.0\/node_modules\/inner$/,
    );
    expect(findPackage(root, 'outer', { from: 'packages/app' })).toMatch(/node_modules\/outer$/);
    // never above the repo: a package installed there is not this repo's
    const repo = join(root, 'packages/app');
    expect(findPackage(repo, 'outer', {})).toMatch(/node_modules\/outer$/);
    writeFile(root, 'node_modules/above/package.json', { name: 'above' });
    expect(findPackage(repo, 'above', {})).toBeUndefined();
  });
});

describe('vendored skills', () => {
  it('renders the copy, its notice and license files, and pins version and sha256', () => {
    const root = vendorRepo();
    expect(updated(root).written).toEqual([
      '.agents/vendor/demo-pkg/LICENSE',
      '.agents/skills/demo/SKILL.md',
      '.agents/vendor.json',
    ]);
    const text = vendored(root);
    const { skills, packages } = loadVendorManifest(root);
    expect(text).toContain(`---\n\n${notice(skills.demo, packages['demo-pkg'])}\n\n# Demo`);
    expect(text).toContain('Vendored from demo-pkg@1.0.0 (skills/demo/SKILL.md), MIT');
    expect(skills.demo.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(root, '.agents/vendor/demo-pkg/LICENSE'), 'utf8')).toBe(
      'MIT License\n',
    );
    expect(vendorProblems(root)).toEqual([]);
    expect(update(root, { oxfmt: undefined }).written).toEqual([]); // reproducible
  });

  it('fails when the copy is edited by hand, and update restores it', () => {
    const root = vendorRepo();
    updated(root);
    writeFile(root, '.agents/skills/demo/SKILL.md', vendored(root).replace('begin', 'start'));
    expect(vendorProblems(root)).toEqual([
      expect.stringMatching(
        /^\.agents\/skills\/demo\/SKILL\.md differs from its rewritten upstream .*never edit a vendored copy/,
      ),
    ]);
    // agents:check reports it too
    expect(check(root)).toContainEqual(
      expect.stringContaining('differs from its rewritten upstream'),
    );
    updated(root);
    expect(vendorProblems(root)).toEqual([]);
  });

  it('reads a copy checked out with CRLF line endings as the same text', () => {
    const root = vendorRepo();
    updated(root);
    writeFile(root, '.agents/skills/demo/SKILL.md', vendored(root).replace(/\n/g, '\r\n'));
    expect(vendorProblems(root)).toEqual([]);
  });

  it('fails when a bump installs another version; update re-pins it and renders the new text', () => {
    const root = vendorRepo();
    updated(root);
    install(root, { version: '1.1.0', upstream: UPSTREAM.replace('to begin', 'to begin, now') });
    expect(vendorProblems(root)).toEqual([
      expect.stringMatching(
        /^demo-pkg 1\.1\.0 is installed, but \.agents\/vendor\.json pins 1\.0\.0/,
      ),
    ]);
    updated(root);
    expect(loadVendorManifest(root).packages['demo-pkg'].version).toBe('1.1.0');
    expect(vendored(root)).toContain('demo-pkg@1.1.0');
    expect(vendored(root)).toContain('to begin, now');
    expect(vendorProblems(root)).toEqual([]);
  });

  it('fails, and update writes nothing, when upstream changed under a rewrite', () => {
    const root = vendorRepo();
    updated(root);
    const before = vendored(root);
    install(root, { version: '2.0.0', upstream: UPSTREAM.replace('## Install', '## Setup') });
    const res = update(root, { oxfmt: undefined });
    expect(res.written).toEqual([]);
    expect(res.problems).toEqual([
      expect.stringMatching(/^rewrite 3 \(section "## Install"\) changes nothing in skill demo/),
    ]);
    expect(vendored(root)).toBe(before);
    expect(loadVendorManifest(root).packages['demo-pkg'].version).toBe('1.0.0');
  });

  it('fails when the installed upstream text is not the pinned one (same version)', () => {
    const root = vendorRepo();
    updated(root);
    install(root, { upstream: `${UPSTREAM}patched\n` });
    expect(vendorProblems(root)).toEqual([
      expect.stringMatching(/ships a skills\/demo\/SKILL\.md that is not the pinned one/),
    ]);
  });

  it('fails when a license copy differs from the package or no notice exists', () => {
    const root = vendorRepo();
    updated(root);
    writeFile(root, '.agents/vendor/demo-pkg/LICENSE', 'edited\n');
    expect(vendorProblems(root)).toEqual([
      expect.stringMatching(
        /^\.agents\/vendor\/demo-pkg\/LICENSE differs from its rewritten upstream/,
      ),
    ]);
    const bare = vendorRepo();
    expect(vendorProblems(bare)).toContainEqual(
      expect.stringMatching(/^\.agents\/vendor\/demo-pkg\/ holds no license notice/),
    );
  });

  it('fails when a vendored skill is not a generated file (formatters would rewrite it)', () => {
    const root = vendorRepo();
    updated(root);
    writeFile(root, '.agents/generated.json', { artifacts: [] });
    expect(vendorProblems(root)).toEqual([
      expect.stringMatching(/^vendored skill demo is not in \.agents\/generated\.json/),
    ]);
  });

  it('fails when a package is gone, and checks only the manifest before `pnpm install`', () => {
    const root = vendorRepo();
    updated(root);
    writeFile(root, '.agents/skills/demo/SKILL.md', 'edited\n');
    rmSync(join(root, 'node_modules/demo-pkg'), { recursive: true });
    // a clone before install: nothing to compare against yet
    rmSync(join(root, 'node_modules'), { recursive: true });
    expect(vendorProblems(root)).toEqual([]);
    // installed, without the package
    writeFile(root, 'node_modules/other/package.json', { name: 'other' });
    expect(vendorProblems(root)).toEqual([
      expect.stringMatching(/^vendored package demo-pkg is not installed \(from the root\)/),
    ]);
  });

  it('checks the manifest shape', () => {
    const root = vendorRepo();
    writeFile(root, '.agents/vendor.json', {
      packages: { p: { license: 'MIT' } },
      skills: { s: { package: 'missing', rewrites: {} } },
    });
    expect(vendorProblems(root)).toEqual(
      expect.arrayContaining([
        '.agents/vendor.json: package p needs "version"',
        '.agents/vendor.json: skill s names package "missing", which is not in "packages"',
        '.agents/vendor.json: skill s needs "file"',
        '.agents/vendor.json: skill s: "rewrites" must be an array',
      ]),
    );
  });

  it('has nothing to check without a manifest', () => {
    expect(vendorProblems(makeRepo({}))).toEqual([]);
  });
});
