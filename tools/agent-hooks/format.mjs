#!/usr/bin/env node
// Claude Code PostToolUse hook (Edit|Write|MultiEdit): format the edited file with oxfmt.
// Never blocks (always exits 0): formatting is a convenience, not a gate — `pnpm check`
// and the pre-commit hook are the gates. Skips generated files and missing tooling.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { findArtifact, loadManifest, repoRoot, toRepoPath } from '../lib/generated.mjs';

const FORMATTABLE = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.css',
  '.md',
  '.yml',
  '.yaml',
  '.graphql',
  '.html',
  '.vue',
]);

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const toolInput = input?.tool_input ?? {};
  const filePath = toolInput.file_path ?? toolInput.path;
  if (typeof filePath !== 'string' || !existsSync(filePath)) process.exit(0);
  if (!FORMATTABLE.has(extname(filePath))) process.exit(0);

  // The project is the session's working directory, not whatever repo the file happens to be in.
  const root = repoRoot(
    typeof input.cwd === 'string' && existsSync(input.cwd) ? input.cwd : process.cwd(),
  );
  const oxfmt = join(root, 'node_modules', '.bin', 'oxfmt');
  if (!existsSync(oxfmt)) process.exit(0);
  const repoPath = toRepoPath(root, filePath);
  // Only format files inside this repository (never plans, home files, other repos).
  if (repoPath.startsWith('../') || repoPath.startsWith('/')) process.exit(0);
  if (findArtifact(loadManifest(root), repoPath)) process.exit(0);

  execFileSync(oxfmt, ['--no-error-on-unmatched-pattern', filePath], {
    cwd: root,
    stdio: 'ignore',
    timeout: 8000,
  });
} catch {
  // Formatting failures never block the agent.
}
process.exit(0);
