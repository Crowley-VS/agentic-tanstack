// Turns a fresh copy of the template into your project. Run via `node scripts/bootstrap.mjs`.
// Zero dependencies (runs before `pnpm install`), erasable TypeScript only.
//
// Every step checks its own postcondition first, so a failed run can simply be re-run.
// The script deletes itself only after everything succeeded.
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
import { dirname, join, resolve } from 'node:path';
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
  '.github/pull_request_template.md',
  '.github/workflows/template-smoke.yml',
  '.github/workflows/release-please.yml',
  '.github/workflows/agent-config-drift.yml',
  '.github/workflows/renovate-regen.yml',
  '.github/renovate.json5',
  'release-please-config.json',
  '.release-please-manifest.json',
];

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
      case '--repo':
        opts.repo = value();
        break;
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
        console.log(
          readFileSync(join(ROOT, 'scripts', 'bootstrap.mjs'), 'utf8')
            .split('\n')
            .slice(1, 6)
            .join('\n'),
        );
        process.exit(0);
        break;
      default:
        fail(`unknown option ${arg}`);
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

function run(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; allowFail?: boolean } = {},
) {
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...opts.env },
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
  return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
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

function isText(buf: Buffer): boolean {
  return !buf.subarray(0, 8000).includes(0);
}

async function main() {
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
  if (template?.repo && origin?.includes(template.repo) && !opts.force) {
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

    const repoSlug =
      opts.repo ??
      origin?.match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1] ??
      `${scope.slice(1)}/${name}`;
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
      if (after !== before) {
        changed++;
        if (!opts.dryRun) writeFileSync(full, after);
      }
    }
    console.log(
      `  ${PLACEHOLDER_SCOPE}/ → ${scope}/, ${PLACEHOLDER_NAME} → ${name} (${changed} files)`,
    );
  } else {
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
    console.log('  removed the scripts project from tsconfig.json');
  }
  if (existsSync(join(ROOT, 'README.project.md'))) {
    if (!opts.dryRun) renameSync(join(ROOT, 'README.project.md'), join(ROOT, 'README.md'));
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

  // 7. Install + regenerate ------------------------------------------------------------------
  if (opts.install) {
    step('Install');
    run('pnpm', ['install']); // not frozen: package names changed
    if (!process.env.CI) run('pnpm', ['exec', 'lefthook', 'install'], { allowFail: true });
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

  // 8. Remove this script, then commit -----------------------------------------------------
  if (!opts.keepScript) {
    rmSync(join(ROOT, 'scripts', 'bootstrap.ts'), { force: true });
    rmSync(join(ROOT, 'scripts', 'bootstrap.mjs'), { force: true });
    try {
      rmdirSync(join(ROOT, 'scripts'));
    } catch {
      // not empty: keep it
    }
  }
  if (opts.commit) {
    step('Commit');
    const identity = tryGit(['config', 'user.email']);
    const dirty = (tryGit(['status', '--porcelain']) ?? '').length > 0;
    if (!identity) console.log('  skipped: set git user.name/user.email, then commit yourself');
    else if (!dirty) console.log('  nothing to commit');
    else {
      run('git', ['add', '-A']);
      const from = template ? `${template.repo}@${template.version}` : 'template';
      run('git', ['commit', '-q', '-m', `chore: bootstrap from ${from}`], {
        env: { LEFTHOOK: '0' },
      });
      console.log('  committed');
    }
  }

  console.log(`
✓ Bootstrapped ${scope}/… (${name}).

Next steps:
  pnpm check                      the definition of done (lint, boundaries, types, tests, agent config)
  pnpm ports                      this checkout's ports and database URLs
  AGENTS.md                       how agents (and you) work in this repo
`);
}

await main();
