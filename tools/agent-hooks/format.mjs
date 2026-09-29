#!/usr/bin/env node
// Claude Code PostToolUse hook (Edit|Write|MultiEdit): format the edited file with oxfmt.
// Never blocks (always exits 0): formatting is a convenience, not a gate — `pnpm check`
// and the pre-commit hook are the gates. Skips generated files and missing tooling. oxfmt
// itself skips the file types it does not format, exactly as in the pre-commit formatter and
// `oxfmt --check` in `pnpm check`.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { nodeBin } from '../lib/bin.mjs';
import { findArtifact, loadManifest, repoRoot, toRepoPath } from '../lib/generated.mjs';

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const toolInput = input?.tool_input ?? {};
  const filePath = toolInput.file_path ?? toolInput.path;
  if (typeof filePath !== 'string' || !existsSync(filePath)) process.exit(0);

  // The project is the session's working directory, not whatever repo the file happens to be in.
  const root = repoRoot(
    typeof input.cwd === 'string' && existsSync(input.cwd) ? input.cwd : process.cwd(),
  );
  const oxfmt = nodeBin(root, 'oxfmt');
  if (!oxfmt) process.exit(0);
  const repoPath = toRepoPath(root, filePath);
  // Only format files inside this repository (never plans, home files, other repos).
  if (repoPath.startsWith('../') || repoPath.startsWith('/')) process.exit(0);
  if (findArtifact(loadManifest(root), repoPath)) process.exit(0);

  const [cmd, ...args] = oxfmt;
  execFileSync(cmd, [...args, '--no-error-on-unmatched-pattern', filePath], {
    cwd: root,
    stdio: 'ignore',
    timeout: 8000,
  });
} catch {
  // Formatting failures never block the agent.
}
process.exit(0);
