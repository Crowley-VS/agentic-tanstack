#!/usr/bin/env node
// `pnpm check` — the definition of done. Runs every gate and reports all failures.
//
//   pnpm check          affected projects only (fast; what agents run before saying "done")
//   pnpm check --all    every project (what CI's template smoke test runs)
//
// Gates: lint (oxlint) · eslint (module boundaries) · typecheck · test · generated-file
// drift · agent-config hygiene · pinned version consistency.
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const nxMode = all || !hasBaseCommit() ? ['run-many', '--all'] : ['affected'];
/** @type {{ name: string, command: string[] }[]} */
const steps = [
  { name: 'nx', command: ['pnpm', 'nx', ...nxMode, '-t', ...TARGETS, '--outputStyle=static'] },
  { name: 'generated files', command: ['node', 'tools/agents.mjs', 'regen', '--check'] },
  { name: 'agent config', command: ['node', 'tools/agents.mjs', 'check'] },
  { name: 'versions', command: ['node', 'tools/check-versions.mjs'] },
];

const failed = [];
for (const { name, command } of steps) {
  console.log(`\n▶ ${name}: ${command.join(' ')}`);
  const [cmd = '', ...args] = command;
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (res.status !== 0) failed.push(name);
}

console.log('');
if (failed.length) {
  console.error(`✗ pnpm check failed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('✓ pnpm check passed');
