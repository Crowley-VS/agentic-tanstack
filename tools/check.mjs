#!/usr/bin/env node
// `pnpm check` — the definition of done. Runs every gate and reports all failures.
//
//   pnpm check          affected projects only (fast; what agents run before saying "done")
//   pnpm check --all    every project (what CI's template smoke test runs)
//
// Gates: lint (oxlint) · eslint (module boundaries) · typecheck · test · lint of the files no
// project owns · agent-config hygiene · generated-file drift · pinned version consistency.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeBin, SHELL_ON_WINDOWS } from './lib/bin.mjs';
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
  { name: 'lint outside projects', command: ['node', 'tools/check.mjs', '--lint-loose'] },
  { name: 'agent config', command: ['node', 'tools/agents.mjs', 'check'] },
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
  const patterns = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'].map((e) => `*.${e}`);
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
  else main();
}
