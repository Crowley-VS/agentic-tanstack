import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { githubRepo, reviewLoopContext } from '../agent-hooks/pr-opened.mjs';
import { makeRepo, runHook } from './helpers.mjs';

const HOOK = resolve(import.meta.dirname, '../agent-hooks/pr-opened.mjs');
const bash = (command, stdout = '', exit_code = 0, stderr = '') => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  tool_response: { stdout, stderr, exit_code },
});
const URL = 'https://github.com/acme/app/pull/42\n';
const REPO = 'acme/app';
/** reviewLoopContext for this repository (acme/app), with the default environment. */
const ctx = (payload, env = {}) => reviewLoopContext(payload, env, REPO);

describe('reviewLoopContext', () => {
  it('has Claude offer review-loop on the new PR, and start it once the user agrees', () => {
    const text = ctx(bash('gh pr create --title x --body-file - <<EOF\nhi\nEOF', URL));
    expect(text).toContain('PR #42');
    expect(text).toContain('Ask the user now whether to start it');
    expect(text).toContain('`review-loop-run` with args {"pr": 42}');
    // no claim of consent the user never gave
    expect(text).not.toMatch(/opt-in|do not ask/i);
  });

  it('starts right away only with the opt-in REVIEW_LOOP_AUTO=1', () => {
    const text = ctx(bash('gh pr create --fill', URL), { REVIEW_LOOP_AUTO: '1' });
    expect(text).toContain('REVIEW_LOOP_AUTO=1');
    expect(text).toContain('Now: run the saved workflow `review-loop-run` with args {"pr": 42}');
    expect(text).not.toContain('Ask the user');
    expect(ctx(bash('gh pr create --fill', URL), { REVIEW_LOOP_AUTO: '0' })).toBeUndefined();
  });

  it('works when gh pr create is part of a longer command', () => {
    expect(ctx(bash('git push -u origin b && gh pr create --fill', URL))).toContain('PR #42');
    // a draft flag of ANOTHER command in the chain is not the PR's
    expect(ctx(bash('git branch -d old && gh pr create --fill', URL))).toContain('Ask the user');
  });

  it('offers the loop when a draft is marked ready', () => {
    expect(ctx(bash('gh pr ready 7'))).toContain('{"pr": 7}');
    expect(
      ctx(bash('gh pr ready', '', 0, '✓ Pull request acme/app#8 is marked as "ready for review"')),
    ).toContain('{"pr": 8}');
    expect(ctx(bash('gh pr ready 7 --undo'))).toBeUndefined();
    // another repository, or no PR it can name
    expect(ctx(bash('gh pr ready 7 -R someone/other'))).toBeUndefined();
    expect(ctx(bash('cd ../other && gh pr ready 7'))).toBeUndefined();
    expect(
      ctx(bash('gh pr ready', '', 0, '✓ Pull request someone/other#8 is marked')),
    ).toBeUndefined();
    expect(ctx(bash('gh pr ready'))).toBeUndefined();
  });

  it('does not offer the loop for drafts, which it says to start on `gh pr ready`', () => {
    for (const cmd of ['gh pr create --draft --fill', 'gh pr create -d --fill', 'gh pr create -df'])
      expect(ctx(bash(cmd, URL)), cmd).toContain('DRAFT');
  });

  it('stays silent when no PR of this repository was opened', () => {
    for (const payload of [
      bash('gh pr create --fill', 'error', 1),
      bash('gh pr view 42', URL),
      bash('echo gh pr created', URL),
      // commands that open no PR print no PR URL
      bash('gh pr create --help', 'Create a pull request on GitHub.\n'),
      bash('gh pr create --web', 'Opening github.com/acme/app/compare/main...b in your browser.\n'),
      bash('gh pr create --dry-run --fill', 'Would have created a Pull Request with:\n'),
      bash('git commit -m "docs: the loop starts on gh pr create"', '[b 1234567] docs\n'),
      // a PR of another repository (-R, or a command run in another checkout)
      bash(
        'gh pr create -R someone/other-repo --fill',
        'https://github.com/someone/other-repo/pull/2\n',
      ),
      bash('cd ../kit && gh pr create --fill', 'https://github.com/acme/kit/pull/3\n'),
      { tool_name: 'Edit', tool_input: {} },
    ])
      expect(ctx(payload), JSON.stringify(payload.tool_input)).toBeUndefined();
    // without a known repository (no GitHub origin) it never guesses
    expect(reviewLoopContext(bash('gh pr create --fill', URL), {}, undefined)).toBeUndefined();
  });

  it('reads owner/repo from https and ssh remotes', () => {
    for (const url of [
      'https://github.com/Acme/App.git',
      'git@github.com:acme/app.git',
      'ssh://git@github.com/acme/app',
    ])
      expect(githubRepo(url), url).toBe('acme/app');
    expect(githubRepo('https://gitlab.com/acme/app.git')).toBeUndefined();
  });
});

/** A checkout whose origin is github.com/acme/app, as the project the hook runs in. */
function project() {
  const root = makeRepo();
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/app.git'], { cwd: root });
  return root;
}

describe('pr-opened hook (process)', () => {
  it("emits PostToolUse additionalContext JSON for the project's PR and exits 0", () => {
    const res = runHook(HOOK, bash('gh pr create --fill', URL), {
      env: { REVIEW_LOOP_AUTO: '', CLAUDE_PROJECT_DIR: project() },
    });
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('PR #42');
    // another repository's PR, from the same project
    const other = runHook(HOOK, bash('gh pr create --fill', 'https://github.com/x/y/pull/1\n'), {
      env: { REVIEW_LOOP_AUTO: '', CLAUDE_PROJECT_DIR: project() },
    });
    expect(other.stdout).toBe('');
  });

  it('prints nothing for unrelated commands and never fails on garbage', () => {
    expect(runHook(HOOK, bash('ls')).stdout).toBe('');
    expect(runHook(HOOK, 'not json').code).toBe(0);
  });
});
