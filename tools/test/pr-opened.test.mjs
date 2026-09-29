import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reviewLoopContext } from '../agent-hooks/pr-opened.mjs';
import { runHook } from './helpers.mjs';

const HOOK = resolve(import.meta.dirname, '../agent-hooks/pr-opened.mjs');
const bash = (command, stdout = '', exit_code = 0) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  tool_response: { stdout, stderr: '', exit_code },
});
const URL = 'https://github.com/acme/app/pull/42\n';

describe('reviewLoopContext', () => {
  it('asks Claude to run review-loop with the new PR number', () => {
    const ctx = reviewLoopContext(
      bash('gh pr create --title x --body-file - <<EOF\nhi\nEOF', URL),
      {},
    );
    expect(ctx).toContain('PR #42');
    expect(ctx).toContain('`review-loop-run` with args {"pr": 42}');
  });

  it('works when gh pr create is part of a longer command', () => {
    expect(
      reviewLoopContext(bash('git push -u origin b && gh pr create --fill', URL), {}),
    ).toContain('PR #42');
  });

  it('starts the loop when a draft is marked ready', () => {
    expect(reviewLoopContext(bash('gh pr ready 7'), {})).toContain('{"pr": 7}');
    expect(reviewLoopContext(bash('gh pr ready 7 --undo'), {})).toBeUndefined();
  });

  it('does not start the loop for drafts, failures, other commands or when opted out', () => {
    expect(reviewLoopContext(bash('gh pr create --draft --fill', URL), {})).toContain('DRAFT');
    expect(reviewLoopContext(bash('gh pr create --fill', 'error', 1), {})).toBeUndefined();
    expect(reviewLoopContext(bash('gh pr view 42', URL), {})).toBeUndefined();
    expect(reviewLoopContext(bash('echo gh pr created', URL), {})).toBeUndefined();
    expect(
      reviewLoopContext(bash('gh pr create --fill', URL), { REVIEW_LOOP_AUTO: '0' }),
    ).toBeUndefined();
    expect(reviewLoopContext({ tool_name: 'Edit', tool_input: {} }, {})).toBeUndefined();
  });

  it('falls back to looking the PR up when the URL is not in the output', () => {
    expect(reviewLoopContext(bash('gh pr create --fill', ''), {})).toContain(
      'gh pr view --json number',
    );
  });
});

describe('pr-opened hook (process)', () => {
  it('emits PostToolUse additionalContext JSON and exits 0', () => {
    const res = runHook(HOOK, bash('gh pr create --fill', URL), { env: { REVIEW_LOOP_AUTO: '' } });
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('PR #42');
  });

  it('prints nothing for unrelated commands and never fails on garbage', () => {
    expect(runHook(HOOK, bash('ls')).stdout).toBe('');
    expect(runHook(HOOK, 'not json').code).toBe(0);
  });
});
