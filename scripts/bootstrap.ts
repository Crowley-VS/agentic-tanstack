// Turns a fresh copy of the template into your project. Run via `node scripts/bootstrap.mjs`
// (`--help` lists every option; see USAGE). Zero dependencies (runs before `pnpm install`),
// erasable TypeScript only.
//
// Every step checks its own postcondition first, so a failed run can simply be re-run.
// The script deletes itself only after everything succeeded, the commit included.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLACEHOLDER_SCOPE = '@acme';
const PLACEHOLDER_NAME = 'acme-app';

/** Files that exist only to maintain the template itself. Missing ones are fine. */
const TEMPLATE_ONLY = [
  // the `scripts` Nx project that lints, typechecks and tests this script (bootstrap.ts and
  // bootstrap.mjs themselves are removed last, after everything succeeded)
  'scripts/project.json',
  'scripts/tsconfig.json',
  'scripts/vitest.config.mjs',
  'scripts/test',
  'CHANGELOG.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  '.github/ISSUE_TEMPLATE',
  // not .github/pull_request_template.md: AGENTS.md asks every project's PRs for its summary and
  // test plan too
  '.github/workflows/template-smoke.yml',
  '.github/workflows/release-please.yml',
  '.github/workflows/agent-config-drift.yml',
  '.github/workflows/renovate-regen.yml',
  '.github/renovate.json5',
  'release-please-config.json',
  '.release-please-manifest.json',
];

export const USAGE = `Usage: node scripts/bootstrap.mjs [options]

Turns a fresh copy of this template into your project: renames the @acme / acme-app placeholders,
writes .env with a generated secret, removes template-only files, records the template version,
installs, formats what it rewrote, commits, and deletes itself. It asks for anything it needs that
no option gives, unless --yes is set. Safe to re-run after a failure.

Options:
  -y, --yes                 never ask: take the defaults (needs --scope and --name)
      --scope <@scope>      npm scope for the internal packages, e.g. @my-org
      --name <name>         project name: lowercase letters, digits and dashes, e.g. my-app
      --repo <owner/repo>   GitHub repository the deploy config points at (default: the origin
                            remote, else <scope>/<name>)
      --license <choice>    keep, replace (MIT with your name) or delete LICENSE (default: ask;
                            replace with --yes)
      --author <name>       copyright holder of a replaced LICENSE (default: git user.name)
      --dry-run             print what would change, write nothing, and stop before installing
      --force               run even though origin is the template repository itself
      --no-install          skip pnpm install, regeneration and the git hooks (formatting too,
                            unless oxfmt is installed already)
      --no-browsers         skip the Playwright browser download
      --no-commit           leave the changes uncommitted
      --keep-script         keep scripts/bootstrap.* instead of deleting them at the end
  -h, --help                print this help`;

type Options = {
  yes: boolean;
  dryRun: boolean;
  force: boolean;
  scope?: string;
  name?: string;
  repo?: string;
  license?: 'keep' | 'replace' | 'delete';
  author?: string;
  install: boolean;
  browsers: boolean;
  commit: boolean;
  keepScript: boolean;
};

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    yes: false,
    dryRun: false,
    force: false,
    install: true,
    browsers: true,
    commit: true,
    keepScript: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v) fail(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--yes':
      case '-y':
        opts.yes = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--force':
        opts.force = true;
        break;
      case '--scope':
        opts.scope = value();
        break;
      case '--name':
        opts.name = value();
        break;
      case '--repo': {
        // owner/repo, or a GitHub URL of it: it is written into .railway/railway.ts as a string
        const repo = value();
        opts.repo = githubSlug(repo) ?? repo;
        if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo))
          fail(`--repo "${repo}" is not a GitHub repository: use owner/repo (or its GitHub URL).`);
        break;
      }
      case '--author':
        opts.author = value();
        break;
      case '--license':
        opts.license = licenseChoice(value());
        break;
      case '--no-install':
        opts.install = false;
        break;
      case '--no-browsers':
        opts.browsers = false;
        break;
      case '--no-commit':
        opts.commit = false;
        break;
      case '--keep-script':
        opts.keepScript = true;
        break;
      case '--help':
      case '-h':
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        fail(`unknown option ${arg}\n\n${USAGE}`);
    }
  }
  return opts;
}

function licenseChoice(value: string): NonNullable<Options['license']> {
  if (value !== 'keep' && value !== 'replace' && value !== 'delete')
    fail(`license must be keep, replace or delete (got "${value}")`);
  return value;
}

function fail(message: string): never {
  console.error(`\n✗ bootstrap: ${message}`);
  process.exit(1);
}

const step = (title: string) => console.log(`\n▶ ${title}`);

/**
 * Whether `cmd` must start through a shell. On Windows `pnpm` (from corepack or `npm i -g`) is a
 * .cmd shim, which only starts through one; its arguments here are fixed words that need no
 * quoting. Nothing else goes through a shell: cmd.exe would split an argument with spaces (the
 * commit message) into several.
 */
export function needsShell(cmd: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && cmd === 'pnpm';
}

/**
 * Environment of every command bootstrap runs. No Nx daemon: one started by bootstrap's own Nx
 * commands outlives it, and the first Nx task after a local bootstrap then fails with an Nx DB
 * error ("FOREIGN KEY constraint failed") although every task passed.
 */
export const CHILD_ENV = { NX_DAEMON: 'false' };

function run(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; allowFail?: boolean } = {},
) {
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...CHILD_ENV, ...opts.env },
    shell: needsShell(cmd),
  });
  if (res.status !== 0 && !opts.allowFail)
    fail(`\`${cmd} ${args.join(' ')}\` failed (exit ${res.status})`);
  return res.status === 0;
}

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function tryGit(args: string[]): string | undefined {
  try {
    return git(args);
  } catch {
    return undefined;
  }
}

function hasCommand(cmd: string): boolean {
  return spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: needsShell(cmd) }).status === 0;
}

/** `owner/repo` of a GitHub remote URL (https, ssh or scp-like), or undefined. */
function githubSlug(url: string | undefined): string | undefined {
  return url?.trim().match(/github\.com[:/]+([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i)?.[1];
}

async function ask(question: string, fallback: string, yes: boolean): Promise<string> {
  if (yes) return fallback;
  // Without a terminal the prompt would wait forever (or die on an unsettled top-level await).
  if (!process.stdin.isTTY)
    fail(
      `cannot ask "${question}": stdin is not a terminal. Run non-interactively with ` +
        '--yes --scope <@scope> --name <name> (and --license keep|replace|delete).',
    );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} (${fallback}): `)).trim();
  rl.close();
  return answer || fallback;
}

function readJson(path: string) {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

function writeJson(path: string, data: unknown) {
  writeFileSync(join(ROOT, path), `${JSON.stringify(data, null, 2)}\n`);
}

const isRemoved = (f: string) =>
  f.startsWith('scripts/bootstrap.') || TEMPLATE_ONLY.some((t) => f === t || f.startsWith(`${t}/`));

/** Git-visible files (tracked + untracked, not ignored) that survive bootstrap. */
function projectFiles(): string[] {
  let out: string | undefined;
  if (existsSync(join(ROOT, '.git'))) {
    out = tryGit(['ls-files', '-co', '--exclude-standard', '-z']);
  } else {
    // No repository yet (a tarball copy in --dry-run, where `git init` is skipped): list the files
    // with a throwaway git dir, so the preview honours .gitignore exactly like the real run.
    const gitDir = mkdtempSync(join(tmpdir(), 'bootstrap-git-'));
    try {
      tryGit(['init', '-q', '--bare', gitDir]);
      out = tryGit([
        `--git-dir=${gitDir}`,
        `--work-tree=${ROOT}`,
        'ls-files',
        '-co',
        '--exclude-standard',
        '-z',
      ]);
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
    }
  }
  if (out === undefined) fail('could not list the project files with git.');
  return out
    .split('\0')
    .filter(Boolean)
    .filter((f) => !isRemoved(f))
    .filter((f) => existsSync(join(ROOT, f)));
}

/** The project name an earlier run put in README.md's first heading, if it looks like one. */
function readmeTitle(): string | undefined {
  const file = join(ROOT, 'README.md');
  if (!existsSync(file)) return undefined;
  const title = readFileSync(file, 'utf8').match(/^# (\S+)\s*$/m)?.[1];
  return title && /^[a-z0-9][a-z0-9-]*$/.test(title) ? title : undefined;
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/**
 * A renamed package.json, formatted as oxfmt formats it: renaming `@acme/db` to `@yourco/db` can
 * move it within its dependency map, which oxfmt keeps sorted (and `pnpm check` checks). Written
 * like JSON.stringify, which is also how oxfmt prints package.json.
 */
export function sortedPackageJson(text: string): string {
  const pkg = JSON.parse(text) as Record<string, unknown>;
  for (const field of DEPENDENCY_FIELDS) {
    const deps = pkg[field];
    if (deps && typeof deps === 'object')
      pkg[field] = Object.fromEntries(
        Object.entries(deps).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function isText(buf: Buffer): boolean {
  return !buf.subarray(0, 8000).includes(0);
}

/**
 * .claude/settings.json without the allow rules for the scripts project's targets (e.g.
 * `Bash(pnpm nx run scripts:test)`): bootstrap deletes that project. Line by line, so the rest of
 * the file keeps its formatting; each such rule is on a line of its own, never the last one.
 */
export function withoutScriptsRules(settings: string): string {
  return settings
    .split('\n')
    .filter((l) => !/^\s*"Bash\(pnpm nx run scripts:[\w-]+\)",\s*$/.test(l))
    .join('\n');
}

/**
 * The CLI script of the oxfmt installed in `root`'s node_modules, or undefined before install (or
 * when the package or its bin is missing). Run with this Node: no `.bin` shim, so no shell.
 */
export function oxfmtEntry(root: string): string | undefined {
  const dir = join(root, 'node_modules', 'oxfmt');
  try {
    const { bin } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const entry: unknown = typeof bin === 'string' ? bin : bin?.oxfmt;
    return typeof entry === 'string' && existsSync(join(dir, entry)) ? join(dir, entry) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Formats what bootstrap rewrote with the repo's own oxfmt and config: a scope longer than @acme
 * pushes a line that was within the difference of the 100-character printWidth over it, and
 * `pnpm check` has a format gate. `files` undefined (a re-run: an earlier run renamed them, and
 * which they were is unknown) formats every file, which changes only what the rename left
 * unformatted: the template's own files already are. oxfmt skips ignored (generated) files even
 * when named (the test pins it for the lockfile and a vendored skill). Before install there is no
 * oxfmt: it says so, returns false, and the next steps name `pnpm format`.
 */
function formatRewritten(files: string[] | undefined): boolean {
  step('Format');
  const oxfmt = oxfmtEntry(ROOT);
  if (!oxfmt) {
    console.log('  skipped: oxfmt is not installed yet; run `pnpm format` after `pnpm install`');
    return false;
  }
  if (files?.length === 0) {
    console.log('  nothing was rewritten');
    return true;
  }
  // No shell: one argument per file. oxfmt skips the ones it does not format (a Dockerfile) or
  // ignores; the flag keeps that from failing when it is all of them.
  const res = spawnSync(
    process.execPath,
    [oxfmt, '--no-error-on-unmatched-pattern', ...(files ?? [])],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (res.status !== 0)
    fail(`oxfmt failed (exit ${res.status}): fix the file it names, then re-run`);
  console.log(`  formatted ${files ? `the ${files.length} rewritten files` : 'every file'}`);
  return true;
}

export async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const template = existsSync(join(ROOT, 'template.json')) ? readJson('template.json') : undefined;
  const pkg = readJson('package.json');

  // 1. Preflight -----------------------------------------------------------------
  step('Preflight');
  if (!hasCommand('git')) fail('git is not installed.');
  if (!hasCommand('pnpm')) {
    fail(
      'pnpm is not installed. Install the pinned version with one of:\n' +
        '  proto install            (uses .prototools)\n' +
        '  corepack enable pnpm\n' +
        `  npm install -g ${pkg.packageManager ?? 'pnpm@11'}`,
    );
  }
  const origin = tryGit(['remote', 'get-url', 'origin']);
  const originSlug = githubSlug(origin);
  // GitHub owner and repository names are case-insensitive; `<template>-demo` is another repo.
  const isTemplate = originSlug?.toLowerCase() === String(template?.repo ?? '').toLowerCase();
  if (template?.repo && isTemplate && !opts.force) {
    fail(
      `this checkout's origin is the template itself (${template.repo}). Bootstrap is for copies of the ` +
        'template; pass --force if you really mean to run it here.',
    );
  }
  if (opts.yes && (!opts.scope || !opts.name)) fail('--yes requires --scope and --name.');
  console.log(`  Node ${process.versions.node}, root ${ROOT}`);

  // 2. Git ----------------------------------------------------------------------------
  step('Git repository');
  if (!existsSync(join(ROOT, '.git'))) {
    if (!opts.dryRun) run('git', ['init', '-q', '-b', 'main']);
    console.log('  initialized a new repository (branch main)');
  } else {
    console.log('  using the existing repository');
  }

  // 3. Rename placeholders -----------------------------------------------------------------
  step('Project name');
  const needsRename = pkg.name?.startsWith(`${PLACEHOLDER_SCOPE}/`);
  /** What this run rewrote, for the format step. */
  const rewritten = new Set<string>();
  let scope = PLACEHOLDER_SCOPE;
  let name = PLACEHOLDER_NAME;
  if (needsRename) {
    scope = opts.scope ?? (await ask('npm scope for internal packages', '@my-org', opts.yes));
    if (!scope.startsWith('@')) scope = `@${scope}`;
    if (!/^@[a-z0-9][a-z0-9._~-]*$/.test(scope))
      fail(`"${scope}" is not a valid npm scope (e.g. @my-org).`);
    name = opts.name ?? (await ask('project name (lowercase, dashes)', 'my-app', opts.yes));
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
      fail(`"${name}" is not a valid project name (use a-z, 0-9, -).`);

    const repoSlug = opts.repo ?? originSlug ?? `${scope.slice(1)}/${name}`;
    const repoFrom = opts.repo
      ? '--repo'
      : originSlug
        ? 'the origin remote'
        : 'a guess: <scope>/<name>';
    let changed = 0;
    for (const file of projectFiles()) {
      const full = join(ROOT, file);
      const buf = readFileSync(full);
      if (!isText(buf)) continue;
      const before = buf.toString('utf8');
      let after = before
        .replaceAll(`${PLACEHOLDER_SCOPE}/`, `${scope}/`)
        .replaceAll(PLACEHOLDER_NAME, name);
      // The deploy config points at the template repo; point it at yours.
      if (template?.repo && file.startsWith('.railway/'))
        after = after.replaceAll(template.repo, repoSlug);
      if (after !== before && basename(file) === 'package.json') after = sortedPackageJson(after);
      if (after !== before) {
        changed++;
        rewritten.add(file);
        if (!opts.dryRun) writeFileSync(full, after);
      }
    }
    console.log(
      `  ${PLACEHOLDER_SCOPE}/ → ${scope}/, ${PLACEHOLDER_NAME} → ${name} (${changed} files)`,
    );
    if (template?.repo) {
      console.log(`  .railway/railway.ts deploys GitHub repository ${repoSlug} (from ${repoFrom})`);
      if (!opts.repo && !originSlug)
        console.log(
          '  check that it is yours before `railway config apply`: edit REPO there, or re-run with --repo',
        );
    }
  } else {
    // A re-run (e.g. after a failed install): an earlier run renamed everything. Report the names
    // it chose: the scope of the root package, and the project name from --name or the README.
    scope = String(pkg.name).match(/^(@[^/]+)\//)?.[1] ?? scope;
    name = opts.name ?? readmeTitle() ?? name;
    console.log(`  already renamed (${pkg.name}); skipping`);
  }

  // 4. .env -------------------------------------------------------------------------------
  step('Environment');
  if (!existsSync(join(ROOT, '.env')) && existsSync(join(ROOT, '.env.example'))) {
    const env = readFileSync(join(ROOT, '.env.example'), 'utf8').replace(
      /^INTERNAL_API_SECRET=.*$/m,
      `INTERNAL_API_SECRET=${randomBytes(32).toString('hex')}`,
    );
    if (!opts.dryRun) writeFileSync(join(ROOT, '.env'), env);
    console.log('  created .env with a generated INTERNAL_API_SECRET');
  } else {
    console.log('  .env already exists (left untouched)');
  }

  // 5. Template-only files + license --------------------------------------------------------
  step('Template files');
  for (const f of TEMPLATE_ONLY) {
    if (existsSync(join(ROOT, f))) {
      if (!opts.dryRun) rmSync(join(ROOT, f), { recursive: true, force: true });
      console.log(`  removed ${f}`);
    }
  }
  // `nx sync` references every project from the root tsconfig; the scripts project is gone.
  const rootTsconfig = existsSync(join(ROOT, 'tsconfig.json')) ? readJson('tsconfig.json') : {};
  const references: { path: string }[] = rootTsconfig.references ?? [];
  const kept = references.filter((r) => r.path.replace(/^\.\//, '') !== 'scripts');
  if (kept.length !== references.length) {
    if (!opts.dryRun) writeJson('tsconfig.json', { ...rootTsconfig, references: kept });
    rewritten.add('tsconfig.json');
    console.log('  removed the scripts project from tsconfig.json');
  }
  const settingsFile = join(ROOT, '.claude', 'settings.json');
  if (existsSync(settingsFile)) {
    const settings = readFileSync(settingsFile, 'utf8');
    const trimmed = withoutScriptsRules(settings);
    if (trimmed !== settings) {
      if (!opts.dryRun) writeFileSync(settingsFile, trimmed);
      rewritten.add('.claude/settings.json');
      console.log("  removed the scripts project's allow rules from .claude/settings.json");
    }
  }
  if (existsSync(join(ROOT, 'README.project.md'))) {
    if (!opts.dryRun) renameSync(join(ROOT, 'README.project.md'), join(ROOT, 'README.md'));
    if (rewritten.delete('README.project.md')) rewritten.add('README.md');
    console.log('  README.project.md → README.md');
  }
  if (existsSync(join(ROOT, 'LICENSE')) && needsRename) {
    const author = opts.author ?? tryGit(['config', 'user.name']) ?? 'the project authors';
    const choice =
      opts.license ??
      (opts.yes
        ? 'replace'
        : licenseChoice(
            await ask('LICENSE: keep, replace (MIT, your name) or delete', 'replace', false),
          ));
    if (choice === 'delete') {
      if (!opts.dryRun) rmSync(join(ROOT, 'LICENSE'));
      console.log('  deleted LICENSE');
    } else if (choice === 'replace') {
      const text = readFileSync(join(ROOT, 'LICENSE'), 'utf8').replace(
        /^Copyright \(c\) .*$/m,
        `Copyright (c) ${new Date().getFullYear()} ${author}`,
      );
      if (!opts.dryRun) writeFileSync(join(ROOT, 'LICENSE'), text);
      console.log(`  LICENSE copyright → ${author}`);
    } else {
      console.log('  kept LICENSE');
    }
  }

  // 6. Provenance ---------------------------------------------------------------------------
  step('Provenance');
  const fresh = readJson('package.json');
  if (!fresh.template && template) {
    fresh.template = { repo: template.repo, version: template.version, commit: template.commit };
    fresh.version = '0.0.0';
    if (!opts.dryRun) {
      writeJson('package.json', fresh);
      rmSync(join(ROOT, 'template.json'));
      rewritten.add('package.json');
    }
    console.log(
      `  recorded template ${template.repo}@${template.version} in package.json#template`,
    );
  } else {
    console.log('  already recorded');
  }

  if (opts.dryRun) {
    console.log('\n(dry run: nothing was written; stopping before install)');
    return;
  }

  // 7. Install, format, regenerate ------------------------------------------------------------
  if (opts.install) {
    step('Install');
    run('pnpm', ['install']); // not frozen: package names changed
    // Its `prepare` script installs the git hooks too, but only on a full install: after a failed
    // first run, pnpm may find everything up to date and run no scripts. Skipped when CI is set.
    run('node', ['tools/agents.mjs', 'install-hooks'], { allowFail: true });
  }
  // after the install (which brings oxfmt), before regeneration and agent sync copy files
  const formatted = formatRewritten(
    needsRename ? [...rewritten].filter((f) => existsSync(join(ROOT, f))) : undefined,
  );
  if (opts.install) {
    run('pnpm', ['nx', 'reset']);
    run('pnpm', ['nx', 'sync']);
    if (readJson('.agents/generated.json').artifacts.length > 0) run('pnpm', ['regen']);
    run('node', ['tools/agents.mjs', 'sync']);
    const hasPlaywright = existsSync(join(ROOT, 'node_modules', '@playwright', 'test'));
    if (opts.browsers && hasPlaywright) {
      step('Browsers (for e2e and browser tests)');
      run('pnpm', ['exec', 'playwright', 'install', 'chromium'], { allowFail: true });
    }
  }

  // 8. Commit, then remove this script ------------------------------------------------------
  // The commit leaves the script out, and the script is deleted only after the commit succeeded:
  // a failed commit leaves it in place to re-run.
  const self = ['scripts/bootstrap.ts', 'scripts/bootstrap.mjs'];
  if (opts.commit) {
    step('Commit');
    const identity = tryGit(['config', 'user.email']);
    if (!identity) console.log('  skipped: set git user.name/user.email, then commit yourself');
    else {
      run('git', ['add', '-A']);
      if (!opts.keepScript) run('git', ['rm', '-q', '--cached', '--ignore-unmatch', '--', ...self]);
      // exits 0 when nothing is staged
      if (tryGit(['diff', '--cached', '--quiet']) !== undefined) console.log('  nothing to commit');
      else {
        // template.json is gone after an earlier run; package.json#template keeps the provenance.
        const provenance = template ?? fresh.template;
        const from = provenance?.repo ? `${provenance.repo}@${provenance.version}` : 'template';
        run('git', ['commit', '-q', '-m', `chore: bootstrap from ${from}`], {
          env: { LEFTHOOK: '0' },
        });
        console.log('  committed');
      }
    }
  }
  if (!opts.keepScript) {
    for (const f of self) rmSync(join(ROOT, f), { force: true });
    try {
      rmdirSync(join(ROOT, 'scripts'));
    } catch {
      // not empty: keep it
    }
  }

  console.log(`
✓ Bootstrapped ${scope}/… (${name}).

Next steps:${
    formatted
      ? ''
      : '\n  pnpm format                     once installed: format what bootstrap renamed (oxfmt was not installed yet)'
  }
  pnpm check                      the definition of done (lint, format, boundaries, types, tests, agent config)
  pnpm ports                      this checkout's ports and database URLs
  node tools/setup-agents.mjs     once per machine: the Claude Code plugins this repo enables, and what they need
  AGENTS.md                       how agents (and you) work in this repo (docs/agents.md for humans)
`);
}
