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
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { needsShell, sortedPackageJson, USAGE, withoutScriptsRules } from '../bootstrap.ts';

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

/** { relative path: sha256 } of every file outside .git. */
function snapshot(root, dir = root, out = {}) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
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
/** The copy's formatting, checked with this repository's oxfmt (the copy has no node_modules). */
function oxfmtCheck(copy) {
  const bin = JSON.parse(readFileSync(join(REPO, 'node_modules/oxfmt/package.json'), 'utf8')).bin;
  const entry = join(REPO, 'node_modules/oxfmt', typeof bin === 'string' ? bin : bin.oxfmt);
  return spawnSync(process.execPath, [entry, '--check', '.'], { cwd: copy, encoding: 'utf8' });
}
const secret = (root) =>
  readFileSync(join(root, '.env'), 'utf8').match(/^INTERNAL_API_SECRET=(.*)$/m)?.[1];

describe('bootstrap', () => {
  it('turns a tarball copy into a project with no template leftovers', () => {
    const copy = archiveCopy();
    const res = bootstrap(copy, [...PROJECT, '--no-install', '--no-commit']);
    expect(res.code, res.out).toBe(0);

    const leftovers = Object.keys(snapshot(copy)).filter((f) => {
      const text = readFileSync(join(copy, f), 'utf8');
      return text.includes('@acme/') || text.includes('acme-app');
    });
    expect(leftovers).toEqual([]);
    for (const gone of ['scripts', 'template.json', '.github/workflows/template-smoke.yml'])
      expect(existsSync(join(copy, gone)), gone).toBe(false);

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
    'a re-run after a failed install reports the chosen name and commits the provenance',
    () => {
      const copy = archiveCopy();
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

      const again = bootstrap(copy, [...PROJECT, '--no-install'], env);
      expect(again.code, again.out).toBe(0);
      expect(again.out).toContain('already renamed (@smoke/source)');
      expect(again.out).toContain('Bootstrapped @smoke/… (smoke-app)');
      const template = JSON.parse(readFileSync(join(REPO, 'template.json'), 'utf8'));
      expect(git('log', '-1', '--format=%s')).toBe(
        `chore: bootstrap from ${template.repo}@${template.version}`,
      );
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

  it.skipIf(process.platform === 'win32')(
    'leaves no Nx daemon behind: the first Nx task after a local (non-CI) bootstrap passes',
    () => {
      // a tarball copy with a fresh repository, as in the report this reproduces
      const copy = archiveCopy();
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
      try {
        const res = bootstrap(copy, PROJECT, env);
        expect(res.code, res.out).toBe(0);
        // the install (not CI) also installed the git hooks
        expect(existsSync(join(copy, '.git/hooks/pre-commit'))).toBe(true);
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
