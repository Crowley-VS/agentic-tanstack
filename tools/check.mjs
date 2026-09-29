#!/usr/bin/env node
// `pnpm check` — the definition of done. Runs every gate and reports all failures.
//
//   pnpm check          affected projects only (fast; what agents run before saying "done")
//   pnpm check --all    every project (what CI's template smoke test runs)
//
// Gates: lint (oxlint) · eslint (module boundaries) · typecheck · test · Nx sync (tsconfig
// project references) · lint of the files no project owns · formatting (oxfmt --check) ·
// agent-config hygiene · Nx's agent config · generated-file drift · pinned version consistency.
//
//   node tools/check.mjs --lint-loose   one gate: oxlint on the files no project owns
//   node tools/check.mjs --format       one gate: every file oxfmt formats is formatted
//   node tools/check.mjs --nx-agents    one gate: `nx configure-ai-agents --check`
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeBin, SHELL_ON_WINDOWS } from './lib/bin.mjs';
import { SCRIPT_EXTENSIONS } from './lib/file-types.mjs';
import { findArtifact, loadManifest } from './lib/generated.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['lint', 'eslint', 'typecheck', 'test'];
const all = process.argv.includes('--all');

function hasBaseCommit() {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    execFileSync('git', ['rev-parse', '--verify', '--quiet', process.env.NX_BASE ?? 'main'], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The gates, in order. `agent config` runs BEFORE `generated files`: regen runs `pnpm agents:sync`,
 * which rewrites the synced files in place, so a check after it would only ever see a fresh sync.
 * @type {(nxMode: string[]) => { name: string, command: string[] }[]}
 */
export const steps = (nxMode) => [
  { name: 'nx', command: ['pnpm', 'nx', ...nxMode, '-t', ...TARGETS, '--outputStyle=static'] },
  // Nx skips its sync generators (tsconfig project references) when CI is set: check them here,
  // so CI and local runs agree
  { name: 'nx sync', command: ['pnpm', 'nx', 'sync:check'] },
  { name: 'lint outside projects', command: ['node', 'tools/check.mjs', '--lint-loose'] },
  // the hooks format edits and commits, but a commit made without them (--no-verify, a web edit,
  // a bot, a clone without hooks) is only caught here
  { name: 'format', command: ['node', 'tools/check.mjs', '--format'] },
  { name: 'agent config', command: ['node', 'tools/agents.mjs', 'check'] },
  { name: 'nx agent config', command: ['node', 'tools/check.mjs', '--nx-agents'] },
  { name: 'generated files', command: ['node', 'tools/agents.mjs', 'regen', '--check'] },
  { name: 'versions', command: ['node', 'tools/check-versions.mjs'] },
];

/**
 * JS/TS files that no Nx project owns (no package.json or project.json between them and the root),
 * e.g. .claude/workflows/*.js and root configs: no project's `lint` target covers them. Generated
 * files are left out, like everywhere else.
 */
export function looseFiles(root = ROOT) {
  const manifest = loadManifest(root);
  const patterns = SCRIPT_EXTENSIONS.map((e) => `*.${e}`);
  const out = execFileSync(
    'git',
    ['ls-files', '-co', '--exclude-standard', '-z', '--', ...patterns],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  const owned = (file) => {
    for (let dir = dirname(file); dir !== '.'; dir = dirname(dir))
      if (
        existsSync(join(root, dir, 'package.json')) ||
        existsSync(join(root, dir, 'project.json'))
      )
        return true;
    return false;
  };
  return [...new Set(out.split('\0').filter(Boolean))]
    .filter((f) => existsSync(join(root, f)) && !owned(f) && !findArtifact(manifest, f))
    .toSorted((a, b) => a.localeCompare(b));
}

/** oxlint (type-aware, like the projects' `lint` targets) on the files no project owns. */
function lintLoose() {
  const files = looseFiles();
  const oxlint = nodeBin(ROOT, 'oxlint');
  if (!oxlint) {
    console.error('oxlint is not installed: run `pnpm install`');
    return 1;
  }
  if (!files.length) return 0;
  console.log(files.join('\n'));
  const [cmd, ...args] = oxlint;
  return spawnSync(cmd, [...args, ...files], { cwd: ROOT, stdio: 'inherit' }).status ?? 1;
}

/**
 * oxfmt --check on the whole repository: every file type oxfmt formats, minus .gitignore and the
 * ignorePatterns of .oxfmtrc.json (generated files are rendered into them). Returns the exit code.
 */
export function formatCheck(
  root = ROOT,
  { oxfmt = nodeBin(root, 'oxfmt'), stdio = 'inherit' } = {},
) {
  if (!oxfmt) {
    console.error('oxfmt is not installed: run `pnpm install`');
    return 1;
  }
  const [cmd, ...args] = oxfmt;
  const status = spawnSync(cmd, [...args, '--check', '.'], { cwd: root, stdio }).status ?? 1;
  if (status !== 0 && stdio === 'inherit')
    console.error('✗ files above are not formatted: run `pnpm format` (or oxfmt on them)');
  return status;
}

/**
 * `nx configure-ai-agents --check`: the CLAUDE.md block, settings and .gitignore lines that Nx
 * writes still match what it would write. Humans update them (`pnpm agents:nx`); agents may not.
 */
function nxAgentsCheck() {
  const nx = nodeBin(ROOT, 'nx');
  if (!nx) {
    console.error('nx is not installed: run `pnpm install`');
    return 1;
  }
  const [cmd, ...args] = nx;
  const status =
    spawnSync(cmd, [...args, 'configure-ai-agents', '--check'], {
      cwd: ROOT,
      stdio: 'inherit',
      // the AI files of the installed Nx version, not the latest ones from the network
      env: { ...process.env, NX_AI_FILES_USE_LOCAL: 'true' },
    }).status ?? 1;
  if (status !== 0)
    console.error(
      "✗ Nx's agent config drifted from what `nx configure-ai-agents` writes: a human runs `pnpm agents:nx` and commits the result",
    );
  return status;
}

function main() {
  const nxMode = all || !hasBaseCommit() ? ['run-many', '--all'] : ['affected'];
  const failed = [];
  for (const { name, command } of steps(nxMode)) {
    console.log(`\n▶ ${name}: ${command.join(' ')}`);
    const [cmd = '', ...args] = command;
    // `pnpm` is a .cmd shim on Windows, which needs a shell (the arguments here need no quoting)
    const res = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...SHELL_ON_WINDOWS });
    if (res.status !== 0) failed.push(name);
  }

  console.log('');
  if (failed.length) {
    console.error(`✗ pnpm check failed: ${failed.join(', ')}`);
    process.exit(1);
  }
  console.log('✓ pnpm check passed');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--lint-loose')) process.exitCode = lintLoose();
  else if (process.argv.includes('--format')) process.exitCode = formatCheck();
  else if (process.argv.includes('--nx-agents')) process.exitCode = nxAgentsCheck();
  else main();
}
