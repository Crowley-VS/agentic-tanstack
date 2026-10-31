import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { steps } from '../check.mjs';
import { anchors, checkDocLinks, links, slug } from '../doc-links.mjs';
import { makeRepo } from './helpers.mjs';

const REPO = resolve(import.meta.dirname, '../..');

describe('doc links', () => {
  it("gives a heading GitHub's id", () => {
    // headings of this repository's docs, and the ids its links use
    expect(slug('The BFF: `POST /api/graphql`')).toBe('the-bff-post-apigraphql');
    expect(slug("Request ids: one id per browser request, in both servers' lines")).toBe(
      'request-ids-one-id-per-browser-request-in-both-servers-lines',
    );
    expect(slug('The version: `APP_VERSION`')).toBe('the-version-app_version');
    expect(slug('0012 — No authentication')).toBe('0012--no-authentication');
    expect(slug('**Bold** [a link](x.md) <code>html</code>')).toBe('bold-a-link-html');
    // a repeated heading gets -1, -2; an HTML anchor counts too
    expect([...anchors('# Setup\n## Setup\n### Setup\n<a id="Custom"></a>\n')]).toEqual([
      'setup',
      'setup-1',
      'setup-2',
      'Custom',
    ]);
    // a heading in a code block is no heading
    expect([...anchors('```md\n# Not a heading\n```\n# Real\n')]).toEqual(['real']);
  });

  it('reads links, images and reference definitions, but none in code or comments', () => {
    const markdown = [
      'See [the doc](docs/a.md#part) and ![a logo](img/logo.svg "Logo").',
      '[![badge](img/badge.svg)](docs/b.md)',
      '`[not a link](code.md)` and <!-- [hidden](comment.md) -->',
      '```bash',
      '[in a block](block.md)',
      '```',
      '[ref]: docs/ref.md',
      '<a href="docs/html.md">html</a>',
    ].join('\n');
    expect(links(markdown)).toEqual([
      { target: 'docs/a.md#part', line: 1 },
      { target: 'img/logo.svg', line: 1 },
      { target: 'img/badge.svg', line: 2 },
      { target: 'docs/b.md', line: 2 },
      { target: 'docs/ref.md', line: 7 },
      { target: 'docs/html.md', line: 8 },
    ]);
  });

  it('passes when every relative link resolves', () => {
    const root = makeRepo({
      'README.md': [
        '[guide](docs/guide.md#the-bff-post-apigraphql) [docs](docs/) [self](#intro)',
        '[web](https://example.com/x.md) [mail](mailto:a@example.com) [code](src/a.ts#L3)',
        '# Intro',
      ].join('\n'),
      'docs/guide.md': '# Guide\n## The BFF: `POST /api/graphql`\n[back](../README.md#intro)\n',
      'src/a.ts': 'export {};\n',
    });
    expect(checkDocLinks(root)).toEqual({ files: 2, links: 5, problems: [] });
  });

  it('reports a missing file or heading, an ignored file, and a link out of the repository', () => {
    const root = makeRepo({
      '.gitignore': '.env\nplans/\n',
      '.env': 'SECRET=1\n',
      'plans/next.md': '# Next\n',
      'docs/guide.md': '# Guide\n',
      'README.md': [
        '[gone](docs/gone.md)',
        '[heading](docs/guide.md#renamed)',
        '[secrets](.env) [plan](plans/next.md)',
        '[out](../elsewhere.md)',
        '[here](#nowhere)',
      ].join('\n'),
    });
    expect(checkDocLinks(root).problems).toEqual([
      'README.md:1: (docs/gone.md): docs/gone.md is not in the repository (renamed, deleted or ignored?)',
      'README.md:2: (docs/guide.md#renamed): docs/guide.md has no heading with the id "renamed"',
      'README.md:3: (.env): .env is not in the repository (renamed, deleted or ignored?)',
      'README.md:3: (plans/next.md): plans/next.md is not in the repository (renamed, deleted or ignored?)',
      'README.md:4: (../elsewhere.md) points outside the repository',
      'README.md:5: (#nowhere): README.md has no heading with the id "nowhere"',
    ]);
  });

  it('leaves generated Markdown out: its source is checked', () => {
    const root = makeRepo({
      '.agents/generated.json': {
        artifacts: [{ id: 'copies', paths: ['copies/**'], regen: 'node copy.mjs' }],
      },
      'copies/SKILL.md': '[broken](nowhere.md)\n',
    });
    expect(checkDocLinks(root)).toEqual({ files: 0, links: 0, problems: [] });
  });

  it('is a pnpm check gate, and exits 1 on a broken link', () => {
    expect(steps([]).find((s) => s.name === 'doc links')?.command).toEqual([
      'node',
      'tools/doc-links.mjs',
    ]);
    // the script checks the repository it is in, wherever it runs from
    const script = ['tools/doc-links.mjs', 'tools/lib/generated.mjs'];
    const root = makeRepo({
      ...Object.fromEntries(script.map((f) => [f, readFileSync(join(REPO, f), 'utf8')])),
      'README.md': '[gone](gone.md) [guide](docs/guide.md)\n',
      'docs/guide.md': '# Guide\n',
    });
    const run = () =>
      spawnSync(process.execPath, [join(root, script[0])], { cwd: tmpdir(), encoding: 'utf8' });
    const broken = run();
    expect(broken.status).toBe(1);
    expect(broken.stderr).toContain('✗ README.md:1: (gone.md): gone.md is not in the repository');
    expect(broken.stderr).toContain('1 broken Markdown link(s)');
    writeFileSync(join(root, 'README.md'), '[guide](docs/guide.md)\n');
    const fixed = run();
    expect(fixed.status, fixed.stderr).toBe(0);
    expect(fixed.stdout).toBe('✓ 1 relative links in 2 Markdown files resolve\n');
  });
});
