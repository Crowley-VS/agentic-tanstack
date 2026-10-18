import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  needsShell,
  oxfmtEntry,
  sortedPackageJson,
  USAGE,
  withoutScriptsRules,
} from '../bootstrap.ts';

const REPO = resolve(import.meta.dirname, '../..');
const PROJECT = ['--yes', '--scope', '@smoke', '--name', 'smoke-app'];

/** A tarball-style copy of the working tree: every git-visible file, no .git (like giget). */
function archiveCopy() {
  const dest = mkdtempSync(join(tmpdir(), 'bootstrap-copy-'));
  onTestFinished(() => rmSync(dest, { recursive: true, force: true }));
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: REPO,
    encoding: 'utf8',
  });
  for (const f of files.split('\0').filter(Boolean)) {
    if (!existsSync(join(REPO, f))) continue; // deleted in the working tree
    mkdirSync(dirname(join(dest, f)), { recursive: true });
    cpSync(join(REPO, f), join(dest, f));
  }
  return dest;
}

/** Run bootstrap in `cwd` with a non-terminal stdin (like an agent or CI). */
function bootstrap(cwd, args, env = process.env) {
  const res = spawnSync(process.execPath, ['scripts/bootstrap.mjs', ...args], {
    cwd,
    encoding: 'utf8',
    input: '',
    env,
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

/** { relative path: sha256 } of every file outside .git and node_modules. */
function snapshot(root, dir = root, out = {}) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.name === 'node_modules' && dir === root) continue; // withOxfmt's link
    if (d.isDirectory()) {
      if (d.name !== '.git') snapshot(root, p, out);
    } else {
      out[relative(root, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  }
  return out;
}

const renamedCount = (out) => Number(out.match(/→ smoke-app \((\d+) files\)/)?.[1]);
/** A dry run in a copy whose git origin is `url`. */
function withOrigin(url) {
  const copy = archiveCopy();
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: copy });
  execFileSync('git', ['remote', 'add', 'origin', url], { cwd: copy });
  return bootstrap(copy, [...PROJECT, '--dry-run']);
}
/** `git …` in `cwd`, returning trimmed stdout. */
const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
/** A "Use this template" copy: every file in one initial commit, with a git identity. */
function templateCopy() {
  const copy = archiveCopy();
  gitIn(copy, 'init', '-q', '-b', 'main');
  gitIn(copy, 'config', 'user.email', 'smoke@example.com');
  gitIn(copy, 'config', 'user.name', 'Smoke');
  gitIn(copy, 'add', '-A');
  gitIn(copy, 'commit', '-q', '-m', 'Initial commit');
  return copy;
}
/** The copy's formatting (of `paths`), checked with this repository's oxfmt. */
function oxfmtCheck(copy, paths = ['.']) {
  const entry = oxfmtEntry(REPO);
  expect(entry, 'oxfmt is not installed: run `pnpm install`').toBeDefined();
  return spawnSync(process.execPath, [entry, '--check', ...paths], { cwd: copy, encoding: 'utf8' });
}
/**
 * A copy with this repository's oxfmt in its node_modules, as after its install: what bootstrap
 * formats with when --no-install skips the install.
 */
function withOxfmt(copy) {
  mkdirSync(join(copy, 'node_modules'), { recursive: true });
  const real = realpathSync(join(REPO, 'node_modules/oxfmt'));
  symlinkSync(real, join(copy, 'node_modules/oxfmt'), 'junction');
  return copy;
}
const AT_THE_LIMIT = 'packages/core/src/at-the-limit.ts';
/**
 * Plants in `copy` an import line of exactly printWidth (100) that holds the placeholder, as the
 * template's own lines may (two names: oxfmt never wraps an import of one). Any longer scope
 * pushes it over.
 */
function plantLineAtTheLimit(copy) {
  const line = `import { a, ${'x'.repeat(55)} } from '@acme/validators/notes';`;
  expect(line).toHaveLength(100);
  writeFileSync(join(copy, AT_THE_LIMIT), `${line}\n`);
  expect(oxfmtCheck(copy).status, 'the template copy is formatted').toBe(0);
  return copy;
}
/** The longest line of a file in `copy`. */
const longestLine = (copy, file) =>
  Math.max(
    ...readFileSync(join(copy, file), 'utf8')
      .split('\n')
      .map((l) => l.length),
  );
const secret = (root) =>
  readFileSync(join(root, '.env'), 'utf8').match(/^INTERNAL_API_SECRET=(.*)$/m)?.[1];
/** The text of every file in a checkout's .railway directory. */
const railwayFiles = (root) =>
  readdirSync(join(root, '.railway'), { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => readFileSync(join(root, '.railway', d.name), 'utf8'));
/** The repository .railway/railway.ts builds from (its REPO constant). */
const railwayRepo = (root) =>
  readFileSync(join(root, '.railway/railway.ts'), 'utf8').match(/^const REPO = '(.*)';$/m)?.[1];

describe('bootstrap', () => {
  it('turns a tarball copy into a project with no template leftovers', () => {
    const copy = withOxfmt(archiveCopy());
    const res = bootstrap(copy, [...PROJECT, '--no-install', '--no-commit']);
    expect(res.code, res.out).toBe(0);

    const leftovers = Object.keys(snapshot(copy)).filter((f) => {
      const text = readFileSync(join(copy, f), 'utf8');
      return text.includes('@acme/') || text.includes('acme-app');
    });
    expect(leftovers).toEqual([]);
    for (const gone of ['scripts', 'template.json', '.github/workflows/template-smoke.yml'])
      expect(existsSync(join(copy, gone)), gone).toBe(false);
    // the template's public files go; its pull request template stays (AGENTS.md asks every PR
    // for a summary and a test plan, in projects too)
    for (const gone of [
      'CHANGELOG.md',
      'CODE_OF_CONDUCT.md',
      'CONTRIBUTING.md',
      'SECURITY.md',
      '.github/ISSUE_TEMPLATE',
    ]) {
      expect(existsSync(join(REPO, gone)), `${gone} in the template`).toBe(true);
      expect(existsSync(join(copy, gone)), gone).toBe(false);
    }
    expect(existsSync(join(copy, '.github/pull_request_template.md'))).toBe(true);
    // what every clone runs stays, with its tests, in the tools project (docs/agents.md)
    for (const kept of ['setup-agents', 'pw-agents'])
      for (const f of [`tools/${kept}.mjs`, `tools/test/${kept}.test.mjs`])
        expect(existsSync(join(copy, f)), f).toBe(true);

    expect(readFileSync(join(copy, 'README.md'), 'utf8')).toMatch(/^# smoke-app\n/);
    const tsconfig = JSON.parse(readFileSync(join(copy, 'tsconfig.json'), 'utf8'));
    expect(tsconfig.references.map((r) => r.path)).not.toContain('./scripts');
    // the scripts project is gone, and so are the allow rules that name its targets
    const before = readFileSync(join(REPO, '.claude/settings.json'), 'utf8');
    expect(before).toContain('"Bash(pnpm nx run scripts:test)"');
    const settings = readFileSync(join(copy, '.claude/settings.json'), 'utf8');
    expect(settings).not.toContain('scripts:');
    expect(JSON.parse(settings).permissions.allow).toEqual(
      JSON.parse(before).permissions.allow.filter((r) => !r.includes(' scripts:')),
    );
    // what bootstrap rewrote is still formatted (`pnpm check` has a format gate)
    const fmt = oxfmtCheck(copy);
    expect(fmt.status, `${fmt.stdout}${fmt.stderr}`).toBe(0);
    const pkg = JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@smoke/source');
    expect(pkg.template.repo).toBeTruthy();

    // .env: a copy of .env.example with a fresh random secret (never the placeholder)
    expect(secret(copy)).toMatch(/^[0-9a-f]{64}$/);
    const example = readFileSync(join(copy, '.env.example'), 'utf8');
    expect(readFileSync(join(copy, '.env'), 'utf8')).toBe(
      example.replace(/^INTERNAL_API_SECRET=.*$/m, `INTERNAL_API_SECRET=${secret(copy)}`),
    );
    const other = archiveCopy();
    expect(bootstrap(other, [...PROJECT, '--no-install', '--no-commit']).code).toBe(0);
    expect(secret(other)).not.toBe(secret(copy));

    // --yes replaces the LICENSE copyright (no git identity here, and no --author)
    expect(readFileSync(join(copy, 'LICENSE'), 'utf8')).toContain(
      `\nCopyright (c) ${new Date().getFullYear()} the project authors\n`,
    );
    const authored = archiveCopy();
    const res2 = bootstrap(authored, [
      ...PROJECT,
      '--no-install',
      '--no-commit',
      '--author',
      'Ada L',
    ]);
    expect(res2.code, res2.out).toBe(0);
    expect(readFileSync(join(authored, 'LICENSE'), 'utf8')).toMatch(
      /^Copyright \(c\) \d{4} Ada L$/m,
    );
  });

  it('formats what it renamed: a scope longer than @acme pushes no line over the limit', () => {
    const SCOPE = '@a-much-longer-scope';
    const LONG = ['--yes', '--scope', SCOPE, '--name', 'smoke-app', '--no-install', '--no-commit'];
    const renamed = (file) =>
      readFileSync(join(REPO, file), 'utf8')
        .replaceAll('@acme/', `${SCOPE}/`)
        .replaceAll('acme-app', 'smoke-app');

    const copy = withOxfmt(plantLineAtTheLimit(archiveCopy()));
    const res = bootstrap(copy, LONG);
    expect(res.code, res.out).toBe(0);
    expect(res.out).toMatch(/formatted the \d+ rewritten files/);
    const fmt = oxfmtCheck(copy);
    expect(fmt.status, `${fmt.stdout}${fmt.stderr}`).toBe(0);
    // the planted line was renamed, then wrapped
    expect(readFileSync(join(copy, AT_THE_LIMIT), 'utf8')).toContain(
      `\n} from '${SCOPE}/validators/notes';\n`,
    );
    expect(longestLine(copy, AT_THE_LIMIT)).toBeLessThanOrEqual(100);
    // named or not, what oxfmt ignores (the lockfile, generated files) is only renamed
    for (const file of ['pnpm-lock.yaml', '.agents/skills/drizzle/SKILL.md']) {
      expect(renamed(file), file).toContain(`${SCOPE}/`);
      expect(readFileSync(join(copy, file), 'utf8'), file).toBe(renamed(file));
    }

    // before its install a copy has no oxfmt: bootstrap says so, the next steps name
    // `pnpm format`, and the rename alone pushed the planted line over the limit
    const bare = plantLineAtTheLimit(archiveCopy());
    const skipped = bootstrap(bare, LONG);
    expect(skipped.code, skipped.out).toBe(0);
    expect(skipped.out).toContain('run `pnpm format` after `pnpm install`');
    expect(skipped.out.slice(skipped.out.indexOf('Next steps:'))).toMatch(/^\s+pnpm format\s/m);
    const unformatted = oxfmtCheck(bare);
    expect(unformatted.status).toBe(1);
    expect(`${unformatted.stdout}${unformatted.stderr}`).toContain(AT_THE_LIMIT);
    // ...while every package.json is formatted: sortedPackageJson sorts the renamed dependencies
    // as oxfmt does (this scope moves @a-much-longer-scope/* in front of @pothos/* and others)
    const manifests = Object.keys(snapshot(bare)).filter((f) => f.endsWith('package.json'));
    expect(manifests.length).toBeGreaterThan(5);
    const pkgs = oxfmtCheck(bare, manifests);
    expect(pkgs.status, `${pkgs.stdout}${pkgs.stderr}`).toBe(0);
  });

  it('points the Railway config at your repository: --repo, else the origin, else <scope>/<name>', () => {
    const upstream = JSON.parse(readFileSync(join(REPO, 'template.json'), 'utf8')).repo;
    expect(railwayRepo(REPO)).toBe(upstream);

    /** A copy whose git origin is a fork of the template on GitHub. */
    const cloned = () => {
      const copy = archiveCopy();
      gitIn(copy, 'init', '-q', '-b', 'main');
      gitIn(copy, 'remote', 'add', 'origin', 'git@github.com:origin-owner/origin-repo.git');
      return copy;
    };
    for (const { copy, args, repo, from } of [
      {
        copy: cloned(),
        args: ['--repo', 'flag-owner/flag-repo'],
        repo: 'flag-owner/flag-repo',
        from: '--repo',
      },
      {
        copy: archiveCopy(),
        args: ['--repo', 'https://github.com/url-owner/url-repo.git'],
        repo: 'url-owner/url-repo',
        from: '--repo',
      },
      { copy: cloned(), args: [], repo: 'origin-owner/origin-repo', from: 'the origin remote' },
      { copy: archiveCopy(), args: [], repo: 'smoke/smoke-app', from: 'a guess' },
    ]) {
      const res = bootstrap(copy, [...PROJECT, '--no-install', '--no-commit', ...args]);
      expect(res.code, res.out).toBe(0);
      expect(railwayRepo(copy), repo).toBe(repo);
      // it says which repository Railway will build, and where that came from
      expect(res.out, repo).toContain(`deploys GitHub repository ${repo} (from ${from}`);
      expect(res.out.includes('check that it is yours'), repo).toBe(from === 'a guess');
      // what the template smoke test checks too: the upstream slug survives nowhere in .railway
      expect(
        railwayFiles(copy).filter((text) => text.includes(upstream)),
        repo,
      ).toEqual([]);
    }
  });

  it('refuses a --repo that is not owner/repo: it is written into railway.ts as a string', () => {
    for (const repo of ["it's/bad", 'no-slash', 'https://gitlab.com/a/b']) {
      const copy = archiveCopy();
      const res = bootstrap(copy, [...PROJECT, '--no-install', '--no-commit', '--repo', repo]);
      expect(res.code, repo).toBe(1);
      expect(res.out, repo).toContain('is not a GitHub repository');
      expect(railwayRepo(copy), repo).toBe(railwayRepo(REPO)); // nothing written
    }
  });

  it('refuses to run in the template itself, whatever the case, but not in repos named like it', () => {
    const template = JSON.parse(readFileSync(join(REPO, 'template.json'), 'utf8')).repo;
    const [owner, name] = template.split('/');
    for (const url of [
      `https://github.com/${template}.git`,
      `git@github.com:${owner.toLowerCase()}/${name.toUpperCase()}.git`,
      `ssh://git@github.com/${template}`,
    ]) {
      const res = withOrigin(url);
      expect(res.code, url).toBe(1);
      expect(res.out, url).toContain("this checkout's origin is the template itself");
    }
    for (const url of [
      `https://github.com/${template}-demo.git`,
      `git@github.com:someone-else/${name}.git`,
    ]) {
      const res = withOrigin(url);
      expect(res.code, `${url}\n${res.out}`).toBe(0);
    }
  });

  it('only suggests next steps that exist', () => {
    const copy = archiveCopy();
    const res = bootstrap(copy, [...PROJECT, '--no-install', '--no-commit']);
    expect(res.code, res.out).toBe(0);
    const steps = res.out
      .slice(res.out.indexOf('Next steps:'))
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter(([first]) => first);
    expect(steps.length).toBeGreaterThan(0);
    const scripts = JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8')).scripts;
    for (const [first, second = ''] of steps) {
      if (first === 'pnpm') expect(scripts, `pnpm ${second}`).toHaveProperty(second);
      else if (first === 'node') expect(existsSync(join(copy, second)), second).toBe(true);
      else expect(existsSync(join(copy, first)), first).toBe(true); // a file or directory
    }
  });

  it('--dry-run on a tarball copy previews the files a real run renames, and writes nothing', () => {
    const dry = archiveCopy();
    const before = snapshot(dry);
    const preview = bootstrap(dry, [...PROJECT, '--dry-run']);
    expect(preview.code, preview.out).toBe(0);
    expect(snapshot(dry)).toEqual(before);
    expect(existsSync(join(dry, '.git'))).toBe(false);

    const real = bootstrap(archiveCopy(), [...PROJECT, '--no-install', '--no-commit']);
    expect(real.code, real.out).toBe(0);
    expect(renamedCount(real.out)).toBeGreaterThan(0);
    expect(renamedCount(preview.out)).toBe(renamedCount(real.out));
  });

  it.skipIf(process.platform === 'win32')(
    'a re-run after a failed install reports the chosen name, formats and commits the provenance',
    () => {
      const copy = plantLineAtTheLimit(archiveCopy());
      // A pnpm whose `install` fails (the first run stops there, after renaming everything).
      const bin = mkdtempSync(join(tmpdir(), 'bootstrap-bin-'));
      onTestFinished(() => rmSync(bin, { recursive: true, force: true }));
      writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\n[ "$1" = install ] && exit 1\nexit 0\n');
      chmodSync(join(bin, 'pnpm'), 0o755);
      const env = { ...process.env, CI: 'true', PATH: `${bin}${delimiter}${process.env.PATH}` };

      const first = bootstrap(copy, PROJECT, env);
      expect(first.code, first.out).toBe(1);
      expect(first.out).toContain('`pnpm install` failed');
      const git = (...args) => execFileSync('git', args, { cwd: copy, encoding: 'utf8' }).trim();
      git('config', 'user.email', 'smoke@example.com');
      git('config', 'user.name', 'Smoke');
      // the first run stopped before formatting: the renamed line is over the limit
      expect(longestLine(copy, AT_THE_LIMIT)).toBeGreaterThan(100);

      // the install went far enough to bring oxfmt; this run no longer knows what was renamed
      withOxfmt(copy);
      const again = bootstrap(copy, [...PROJECT, '--no-install'], env);
      expect(again.code, again.out).toBe(0);
      expect(again.out).toContain('already renamed (@smoke/source)');
      expect(again.out).toContain('formatted every file');
      expect(again.out).toContain('Bootstrapped @smoke/… (smoke-app)');
      const fmt = oxfmtCheck(copy);
      expect(fmt.status, `${fmt.stdout}${fmt.stderr}`).toBe(0);
      expect(longestLine(copy, AT_THE_LIMIT)).toBeLessThanOrEqual(100);
      const template = JSON.parse(readFileSync(join(REPO, 'template.json'), 'utf8'));
      expect(git('log', '-1', '--format=%s')).toBe(
        `chore: bootstrap from ${template.repo}@${template.version}`,
      );
      expect(git('status', '--porcelain')).toBe(''); // the formatted files are in the commit
    },
  );

  it('--help documents every option it accepts; an unknown option prints the same help', () => {
    const source = readFileSync(join(REPO, 'scripts/bootstrap.ts'), 'utf8');
    const options = [...source.matchAll(/^\s*case '(-[-\w]+)':/gm)].map((m) => m[1]);
    expect(options).toEqual(expect.arrayContaining(['--yes', '--dry-run', '--keep-script', '-h']));
    const help = bootstrap(archiveCopy(), ['--help']);
    expect(help.code).toBe(0);
    expect(help.out.trim()).toBe(USAGE);
    for (const option of options)
      expect(help.out, option).toMatch(new RegExp(`(^|[\\s,])${option}\\b`));
    const unknown = bootstrap(archiveCopy(), ['--frobnicate']);
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain('unknown option --frobnicate');
    expect(unknown.out).toContain(USAGE);
  });

  it('starts only pnpm through a shell (cmd.exe would split the commit message)', () => {
    expect(needsShell('pnpm', 'win32')).toBe(true);
    for (const cmd of ['git', 'node']) expect(needsShell(cmd, 'win32'), cmd).toBe(false);
    for (const cmd of ['pnpm', 'git']) expect(needsShell(cmd, 'linux'), cmd).toBe(false);
  });

  it('drops only whole allow-rule lines for the scripts project', () => {
    const text =
      '{\n  "allow": [\n    "Bash(pnpm nx run scripts:test)",\n    "Bash(pnpm nx run tools:test)"\n  ]\n}\n';
    expect(withoutScriptsRules(text)).toBe(
      '{\n  "allow": [\n    "Bash(pnpm nx run tools:test)"\n  ]\n}\n',
    );
  });

  it('re-sorts the dependencies a new scope moves, keeping every other key in place', () => {
    const renamed = JSON.stringify({
      name: '@zed/api',
      dependencies: { '@zed/db': 'workspace:*', '@pothos/core': '^4', graphql: '16' },
      devDependencies: { tsx: '^4', '@zed/testing': 'workspace:*' },
      nx: { tags: ['scope:api'] },
    });
    expect(sortedPackageJson(renamed)).toBe(
      `${JSON.stringify(
        {
          name: '@zed/api',
          dependencies: { '@pothos/core': '^4', '@zed/db': 'workspace:*', graphql: '16' },
          devDependencies: { '@zed/testing': 'workspace:*', tsx: '^4' },
          nx: { tags: ['scope:api'] },
        },
        null,
        2,
      )}\n`,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'keeps itself when the commit fails, and a re-run commits without it, then deletes it',
    () => {
      const copy = templateCopy();
      const hook = join(copy, '.git/hooks/pre-commit');
      writeFileSync(hook, '#!/bin/sh\necho "refusing to commit" >&2\nexit 1\n');
      chmodSync(hook, 0o755);

      const first = bootstrap(copy, [...PROJECT, '--no-install']);
      expect(first.code, first.out).toBe(1);
      expect(first.out).toContain('`git commit -q -m chore: bootstrap from');
      for (const f of ['scripts/bootstrap.ts', 'scripts/bootstrap.mjs'])
        expect(existsSync(join(copy, f)), f).toBe(true);

      rmSync(hook);
      const again = bootstrap(copy, [...PROJECT, '--no-install']);
      expect(again.code, again.out).toBe(0);
      expect(existsSync(join(copy, 'scripts'))).toBe(false);
      expect(gitIn(copy, 'log', '-1', '--format=%s')).toMatch(/^chore: bootstrap from /);
      expect(gitIn(copy, 'show', '--name-status', '--format=', 'HEAD')).toMatch(
        /^D\tscripts\/bootstrap\.ts$/m,
      );
      expect(gitIn(copy, 'status', '--porcelain')).toBe('');
    },
  );

  // The one bootstrap with its install: the order the other tests cannot see (install → format →
  // nx sync, regen and agent sync → commit). A scope longer than @acme makes the format step
  // matter: formatting before the install (no oxfmt yet), after agent sync or after the commit
  // leaves a line over the limit, stale skill copies or uncommitted changes.
  it.skipIf(process.platform === 'win32')(
    'formats and commits the rename after its install, and leaves no Nx daemon behind: the first Nx task after a local (non-CI) bootstrap passes',
    () => {
      // a tarball copy with a fresh repository, as in the report this reproduces
      const copy = plantLineAtTheLimit(archiveCopy());
      gitIn(copy, 'init', '-q', '-b', 'main');
      gitIn(copy, 'config', 'user.email', 'smoke@example.com');
      gitIn(copy, 'config', 'user.name', 'Smoke');
      // a developer's shell: not CI (CI=false also overrides GITHUB_ACTIONS for Nx), and none of
      // the Nx task variables of the run we are in
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith('NX_')),
      );
      Object.assign(env, { CI: 'false', NX_NO_CLOUD: 'true' });
      const pnpm = (...args) =>
        spawnSync('pnpm', args, { cwd: copy, env, encoding: 'utf8', input: '' });
      const SCOPE = '@a-much-longer-scope';
      try {
        const res = bootstrap(copy, ['--yes', '--scope', SCOPE, '--name', 'smoke-app'], env);
        expect(res.code, res.out).toBe(0);
        // the install (not CI) also installed the git hooks
        expect(existsSync(join(copy, '.git/hooks/pre-commit'))).toBe(true);
        // formatted after the install brought oxfmt: the planted line was renamed, then wrapped
        expect(res.out).toMatch(/formatted the \d+ rewritten files/);
        expect(readFileSync(join(copy, AT_THE_LIMIT), 'utf8')).toContain(
          `\n} from '${SCOPE}/validators/notes';\n`,
        );
        expect(longestLine(copy, AT_THE_LIMIT)).toBeLessThanOrEqual(100);
        const fmt = oxfmtCheck(copy);
        expect(fmt.status, `${fmt.stdout}${fmt.stderr}`).toBe(0);
        // before agent sync: the skill copies match their formatted sources
        const agents = spawnSync(process.execPath, ['tools/agents.mjs', 'check'], {
          cwd: copy,
          encoding: 'utf8',
        });
        expect(agents.status, `${agents.stdout}${agents.stderr}`).toBe(0);
        // before the commit: it holds every formatted file
        expect(gitIn(copy, 'status', '--porcelain')).toBe('');
        const task = pnpm('nx', 'run', 'validators:lint', '--outputStyle=static');
        const out = `${task.stdout}${task.stderr}`;
        expect(out).not.toContain('DB transaction error');
        expect(task.status, out).toBe(0);
      } finally {
        pnpm('nx', 'daemon', '--stop');
      }
    },
    180_000,
  );

  it('fails with a readable error instead of prompting when stdin is not a terminal', () => {
    const res = bootstrap(archiveCopy(), ['--dry-run']);
    expect(res.code).toBe(1);
    expect(res.out).toContain('stdin is not a terminal');
    expect(res.out).not.toContain('unsettled top-level await');
  });
});
