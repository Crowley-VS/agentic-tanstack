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

  it('fails with a readable error instead of prompting when stdin is not a terminal', () => {
    const res = bootstrap(archiveCopy(), ['--dry-run']);
    expect(res.code).toBe(1);
    expect(res.out).toContain('stdin is not a terminal');
    expect(res.out).not.toContain('unsettled top-level await');
  });
});
