// Renovate's config (.github/renovate.json5) and the workflow that regenerates the generated files
// on its branches (.github/workflows/renovate-regen.yml, with tools/renovate-regen.mjs): what
// docs/maintaining.md says they do. Renovate itself cannot run here; `pnpm dlx --package renovate
// renovate-config-validator --strict` validates the config against Renovate's schema. tools:test's
// inputs include both files, so a change to either re-runs these.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { catalogVersions, dockerfiles, dockerfileVersions, LOCKSTEP } from '../check-versions.mjs';
import { commitAll, makeRepo, writeFile } from './helpers.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(join(REPO, path), 'utf8');

/** JSON5 is a subset of JavaScript's object literals: evaluated in an empty context. */
const renovate = runInNewContext(`(${read('.github/renovate.json5')}\n)`);
const rules = renovate.packageRules;
const catalog = catalogVersions(REPO);

/** Renovate's `matchPackageNames` entry `pattern` (an exact name, or a glob ending in `/*`). */
const matchesName = (pattern, name) =>
  pattern.endsWith('/*')
    ? name.startsWith(pattern.slice(0, -1)) && !name.slice(pattern.length - 1).includes('/')
    : pattern === name;
const rulesFor = (name) =>
  rules.filter((r) => r.matchPackageNames?.some((pattern) => matchesName(pattern, name)));
/** What the last matching rule sets, as Renovate merges package rules in order. */
const setting = (name, key) => rulesFor(name).findLast((r) => key in r)?.[key];
/** A Renovate regex string (`/…/`) as a RegExp. */
const regex = (pattern) => {
  expect(pattern).toMatch(/^\/.*\/$/);
  return new RegExp(pattern.slice(1, -1));
};

describe('Renovate (.github/renovate.json5)', () => {
  it('re-runs these checks whenever one of the files they read changes', () => {
    expect(JSON.parse(read('tools/package.json')).nx.targets.test.inputs).toEqual(
      expect.arrayContaining([
        '{workspaceRoot}/.github/renovate.json5',
        '{workspaceRoot}/.github/workflows/*.yml',
        '{workspaceRoot}/pnpm-workspace.yaml',
        '{workspaceRoot}/**/Dockerfile',
        '{workspaceRoot}/docker-compose*.yml',
        '{workspaceRoot}/.agents/skills/**/*',
      ]),
    );
  });

  it('holds the stack to the versions it supports', () => {
    expect(setting('vitest', 'allowedVersions')).toBe('<5');
    expect(setting('@vitest/browser-playwright', 'allowedVersions')).toBe('<5');
    expect(setting('typescript', 'allowedVersions')).toBe('<6.1');
    expect(setting('graphql', 'allowedVersions')).toBe('<17');
    expect(setting('pnpm', 'allowedVersions')).toBe('<12');
    // the production database's major (Railway's Postgres 18)
    expect(setting('postgres', 'allowedVersions')).toBe('<19');
    // Node: even majors only, the LTS lines (Renovate's node versioning also waits for LTS day)
    const lts = regex(setting('node', 'allowedVersions'));
    for (const version of ['24.21.0', '24.22.0-trixie-slim', '26.0.0', 'v28.1.0'])
      expect(lts.test(version), version).toBe(true);
    for (const version of ['25.0.0', '27.1.0-trixie-slim', '23.11.0', 'v19.0.0'])
      expect(lts.test(version), version).toBe(false);
  });

  it('leaves Nx and its plugins to `nx migrate` (skill nx-upgrade)', () => {
    const nx = Object.keys(catalog).filter((name) => name === 'nx' || name.startsWith('@nx/'));
    expect(nx.length).toBeGreaterThan(1);
    for (const name of nx) expect(setting(name, 'enabled'), name).toBe(false);
    expect(read('.agents/skills/nx-upgrade/SKILL.md')).toContain('Renovate');
  });

  it('moves the catalog entries tools/check-versions.mjs keeps in lockstep in one PR', () => {
    for (const [lead, follower] of LOCKSTEP) {
      const names = follower.endsWith('/*')
        ? Object.keys(catalog).filter((name) => matchesName(follower, name))
        : [follower];
      for (const name of [lead, ...names].filter((n) => n in catalog)) {
        // Nx: not updated at all (above)
        if (setting(lead, 'enabled') === false) expect(setting(name, 'enabled'), name).toBe(false);
        else
          expect(setting(name, 'groupName'), `${lead} and ${name}`).toBe(
            setting(lead, 'groupName'),
          );
      }
      if (setting(lead, 'enabled') !== false) expect(setting(lead, 'groupName'), lead).toBeTruthy();
    }
  });

  it('bumps Node and pnpm at every pin tools/check-versions.mjs compares, in one PR each', () => {
    // .node-version (nodenv), .prototools (proto) and package.json#packageManager (npm) are read
    // by Renovate's own managers; the Dockerfiles' `pnpm@<version>` by this regex manager
    expect(setting('node', 'groupName')).toBe('Node');
    expect(setting('@types/node', 'groupName')).toBe('Node');
    expect(setting('pnpm', 'groupName')).toBe('pnpm');
    const managers = renovate.customManagers.filter(
      (m) => m.depNameTemplate === 'pnpm' && m.datasourceTemplate === 'npm',
    );
    expect(managers).toHaveLength(1);
    const [manager] = managers;
    const patterns = manager.managerFilePatterns.map(regex);
    const files = dockerfiles(REPO);
    expect(files).toEqual(expect.arrayContaining(['apps/api/Dockerfile', 'apps/web/Dockerfile']));
    for (const file of [
      ...files,
      'Containerfile',
      'apps/x/Dockerfile.prod',
      'docker/web.Dockerfile',
    ])
      expect(
        patterns.some((p) => p.test(file)),
        file,
      ).toBe(true);
    for (const file of files) {
      const text = read(file);
      const pins = dockerfileVersions(text).pnpm.map(([, version]) => version);
      const found = manager.matchStrings.flatMap((s) =>
        [...text.matchAll(new RegExp(s, 'g'))].map((m) => m.groups.currentValue),
      );
      expect(pins.length, file).toBeGreaterThan(0);
      expect(found, file).toEqual(pins);
    }
  });

  it('pins every image the repository runs by digest', () => {
    const images = [
      ...dockerfiles(REPO).flatMap((file) =>
        [...read(file).matchAll(/^FROM\s+(?:--\S+\s+)*([^\s:@]+)/gm)].map((m) => m[1]),
      ),
      ...['docker-compose.yml', 'docker-compose.stack.yml'].flatMap((file) =>
        [...read(file).matchAll(/^\s+image:\s*([^\s:@]+)/gm)].map((m) => m[1]),
      ),
    ];
    expect(new Set(images)).toEqual(new Set(['node', 'postgres']));
    for (const image of images) expect(setting(image, 'pinDigests'), image).toBe(true);
  });

  it('follows the tags of the prereleases it updates, and never automerges them', () => {
    expect(renovate.automerge).not.toBe(true);
    const prereleases = Object.entries(catalog).filter(([, version]) => /^\d[\d.]*-/.test(version));
    expect(prereleases.map(([name]) => name)).toEqual(
      expect.arrayContaining(['drizzle-orm', 'drizzle-kit', 'nitro']),
    );
    for (const [name] of prereleases) {
      expect(setting(name, 'automerge'), name).toBe(false);
      expect(setting(name, 'followTag'), name).toBeTruthy();
    }
    // Drizzle's latest tag is still 0.x, and its other prereleases are branch builds
    expect(setting('drizzle-orm', 'followTag')).toBe('rc');
    expect(setting('nitro', 'followTag')).toBe('latest');
    // the Pothos plugin is built against one Drizzle
    expect(setting('@pothos/plugin-drizzle', 'groupName')).toBe(
      setting('drizzle-orm', 'groupName'),
    );
  });

  it("treats the regen workflow's commits as Renovate's own: it keeps updating the branch", () => {
    const email = read('.github/workflows/renovate-regen.yml').match(
      /^ {2}REGEN_AUTHOR_EMAIL: '([^']+)'$/m,
    )?.[1];
    expect(email).toBe('41898282+github-actions[bot]@users.noreply.github.com');
    expect(renovate.gitIgnoredAuthors).toContain(email);
    // and the workflow skips the push of its own commit
    expect(read('.github/workflows/renovate-regen.yml')).toContain(
      `github.event.head_commit.author.email != '${email}'`,
    );
  });
});

/** The jobs of a workflow (two-space `jobs:` entries), by id, as text. */
function jobs(text) {
  const body = text.slice(text.indexOf('\njobs:\n') + '\njobs:\n'.length);
  return Object.fromEntries(
    body
      .split(/^(?= {2}[\w-]+:$)/m)
      .map((block) => [block.match(/^ {2}([\w-]+):$/m)?.[1], block])
      .filter(([id]) => id),
  );
}

describe('renovate-regen (.github/workflows/renovate-regen.yml)', () => {
  // without its comment lines, which name what it must not do
  const text = read('.github/workflows/renovate-regen.yml').replaceAll(/^\s*#.*\n/gm, '');
  const { regen, push } = jobs(text);

  it("runs for pushes to this repository's Renovate branches, never for a fork's pull request", () => {
    expect(text).toMatch(/^on:\n {2}push:\n {4}branches: \['renovate\/\*\*'\]\n\n/m);
    // pull_request_target would hand a fork's code this repository's secrets
    expect(text).not.toMatch(/pull_request|workflow_run/);
    expect(text).toMatch(/^permissions: \{\}$/m);
    expect(Object.keys(jobs(text))).toEqual(['regen', 'push']);
  });

  it('runs the update in a job that holds no secret and only a read-only token', () => {
    expect(regen).toContain('run: pnpm install --frozen-lockfile');
    expect(regen).toContain('run: pnpm regen');
    expect(regen).not.toContain('secrets.');
    expect(regen).not.toContain('create-github-app-token');
    expect(regen).toMatch(/\n {4}permissions:\n {6}contents: read\n {4}\w/);
    expect(regen).toContain('persist-credentials: false');
    // nothing to do without the App: not even a runner
    expect(regen).toMatch(/if: >-\n\s+vars\.AUTOMATION_APP_CLIENT_ID != ''/);
  });

  it('pushes only a patch of generated files, from a job that runs none of the update', () => {
    expect(push).toContain('needs: regen');
    // no install, no script of the repository's but the check
    expect(push).not.toMatch(/^\s*(?:run:\s*)?pnpm\s/m);
    expect([...push.matchAll(/^\s*(?:run:\s*)?node\s+(\S+)/gm)].map((m) => m[1])).toEqual([
      'tools/renovate-regen.mjs',
    ]);
    expect(push).toMatch(/\n {4}permissions:\n {6}contents: read\n {4}\w/);
    expect(push).toContain('persist-credentials: false');
    // staged in the index only: the check runs from the commit's own files, then the commit, then
    // a token for this repository's contents alone, then a plain push
    const order = [
      'git apply --cached ',
      'node tools/renovate-regen.mjs check',
      'commit --quiet',
      'uses: actions/create-github-app-token@',
      'git push origin "HEAD:refs/heads/$BRANCH"',
    ].map((step) => push.indexOf(step));
    expect(order.every((at) => at > 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect([...push.matchAll(/permission-[\w-]+: \w+/g)].map((m) => m[0])).toEqual([
      'permission-contents: write',
    ]);
    expect(push).not.toMatch(/git push[^\n]*(?:--force|\s-f\b|\+)/);
  });
});

describe('tools/renovate-regen.mjs check', () => {
  const MANIFEST = {
    artifacts: [{ id: 'gql', paths: ['src/gql/**'], regen: 'true' }],
  };
  /** A repo with a generated file and a source, and `change` staged as the workflow stages it. */
  function staged(change) {
    const root = makeRepo({
      '.agents/generated.json': MANIFEST,
      'src/gql/graphql.ts': 'export {};\n',
      'src/gql/old.ts': 'export {};\n',
      'src/app.ts': 'export {};\n',
    });
    commitAll(root);
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    change(root);
    git('add', '--all');
    const patch = git('diff', '--cached', '--binary', '--no-renames');
    git('reset', '-q', '--hard');
    git('clean', '-qfd');
    writeFile(root, 'regen.patch', patch);
    git('apply', '--cached', 'regen.patch');
    unlinkSync(join(root, 'regen.patch'));
    const res = spawnSync(process.execPath, [join(REPO, 'tools/renovate-regen.mjs'), 'check'], {
      cwd: root,
      encoding: 'utf8',
    });
    return { code: res.status, out: `${res.stdout}${res.stderr}` };
  }

  it('passes regenerated, new and deleted generated files', () => {
    const res = staged((root) => {
      writeFile(root, 'src/gql/graphql.ts', 'export const changed = 1;\n');
      writeFile(root, 'src/gql/new.ts', 'export {};\n');
      unlinkSync(join(root, 'src/gql/old.ts'));
    });
    expect(res.out).toContain('3 generated files changed');
    expect(res.code, res.out).toBe(0);
  });

  it('refuses a change to any other file, naming it', () => {
    const res = staged((root) => {
      writeFile(root, 'src/gql/graphql.ts', 'export const changed = 1;\n');
      writeFile(root, 'src/app.ts', 'export const injected = 1;\n');
    });
    expect(res.code).toBe(1);
    expect(res.out).toContain('src/app.ts: not a generated file');
    expect(res.out).not.toContain('src/gql/graphql.ts:');
  });

  it('refuses a patch that widens the manifest it is checked against', () => {
    const res = staged((root) =>
      writeFile(root, '.agents/generated.json', {
        artifacts: [{ id: 'all', paths: ['**'], regen: 'true' }],
      }),
    );
    expect(res.code).toBe(1);
    expect(res.out).toContain('.agents/generated.json: not a generated file');
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symbolic link, even at a generated path',
    () => {
      const res = staged((root) => symlinkSync('/etc/passwd', join(root, 'src/gql/link.ts')));
      expect(res.code).toBe(1);
      expect(res.out).toContain('src/gql/link.ts: mode 120000, not a plain file');
    },
  );
});
