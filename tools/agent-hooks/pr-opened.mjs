#!/usr/bin/env node
// Claude Code PostToolUse hook (Bash: `gh pr create …` / `gh pr ready …`).
// When a pull request is opened (or a draft is marked ready), tell Claude to run the
// review loop on it right away — the repo's rule is "phase PR → review loop → human merges".
//
// Draft PRs are skipped (mark it ready with `gh pr ready` to start the loop).
// Opt out per machine: set REVIEW_LOOP_AUTO=0 (e.g. "env" in .claude/settings.local.json).
// Never blocks and never fails the tool call: always exits 0.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pure: decide what to tell Claude for a Bash PostToolUse payload (or undefined = nothing). */
export function reviewLoopContext(input, env = process.env) {
  if (env.REVIEW_LOOP_AUTO === '0') return undefined;
  if (input?.tool_name !== 'Bash') return undefined;
  const command = String(input.tool_input?.command ?? '');
  const response = input.tool_response ?? {};
  if (typeof response.exit_code === 'number' && response.exit_code !== 0) return undefined;

  const creates = /(?:^|[\s;&|(])gh\s+pr\s+create\b/.test(command);
  const readies = /(?:^|[\s;&|(])gh\s+pr\s+ready\b/.test(command);
  if (!creates && !readies) return undefined;
  if (creates && /\s--draft\b|\s-d\b/.test(command)) {
    return 'A DRAFT pull request was opened. The review loop starts when it is marked ready (`gh pr ready`); do not run it now.';
  }
  if (readies && /\s--undo\b/.test(command)) return undefined;

  const output = `${response.stdout ?? ''}\n${response.stderr ?? ''}`;
  const url = output.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/);
  const fromReady = command.match(/gh\s+pr\s+ready\s+(\d+)/);
  const pr = url?.[1] ?? fromReady?.[1];
  const target = pr
    ? `PR #${pr}`
    : 'the pull request that was just opened (find its number with `gh pr view --json number -q .number`)';
  const args = pr ? `{"pr": ${pr}}` : '{"pr": <number>}';

  return [
    `${target} is ready for review. This repository runs its review loop automatically on every opened PR`,
    '(AGENTS.md → "Pull requests"; the user enabled this hook to start it without asking).',
    `Now: run the saved workflow \`review-loop\` with args ${args} and tell the user it started.`,
    'It reviews (3 lenses + a hands-on tester), posts findings as inline comments, fixes them, and re-reviews',
    'until nothing new or open remains. It works in its own git worktrees, so the user can keep working; never merge the PR.',
  ].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const context = reviewLoopContext(input);
    if (context) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context },
        }),
      );
    }
  } catch {
    // A broken hook must never break the Bash call.
  }
  process.exit(0);
}
