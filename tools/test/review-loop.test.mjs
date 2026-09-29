// Runs .claude/workflows/review-loop.js against scripted agents: the script's control flow
// (what is posted, fixed, re-reported and summarized) is plain JavaScript and testable here.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commentBody, findingId } from '../pr-review.mjs';

const SOURCE = readFileSync(
  resolve(import.meta.dirname, '../../.claude/workflows/review-loop.js'),
  'utf8',
);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const SHA = 'a'.repeat(40);

const DEFAULTS = {
  head: () => ({ sha: SHA, branch: 'feature' }),
  threads: () => ({ threads: [] }),
  review: () => ({ findings: [] }),
  verify: () => ({ valid: true, reason: 'confirmed' }),
  post: () => 'posted',
  fix: () => ({ checkPassed: true, commit: 'b'.repeat(40), resolutions: [] }),
  summary: () => 'commented',
};

// Like the workflow runtime: a thunk that throws resolves to null.
const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)));

/** Run the workflow; `responders[kind](call)` answers agent calls (kind = label prefix). */
async function runLoop(responders = {}, args = { pr: 7, maxRounds: 3 }) {
  const calls = [];
  const agent = async (prompt, opts = {}) => {
    const call = { kind: String(opts.label).split(':')[0], label: opts.label, prompt, opts };
    calls.push(call);
    return (responders[call.kind] ?? DEFAULTS[call.kind])(call);
  };
  const body = SOURCE.replace(/^export const meta =/m, 'const meta =');
  const run = new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', body);
  const result = await run(
    args,
    agent,
    parallel,
    () => {},
    () => {},
  );
  const summary = calls.find((c) => c.kind === 'summary')?.prompt ?? '';
  return { result, calls, summary, of: (kind) => calls.filter((c) => c.kind === kind) };
}

const finding = {
  path: 'tools/check.mjs',
  line: 999, // not a diff line: posted in the review body, so it never gets a thread
  severity: 'major',
  title: 'Gate order hides drift',
  body: 'why',
};
const reviewerFinds =
  (rounds = [1, 2, 3]) =>
  ({ label }) =>
    label.startsWith('review:correctness') && rounds.some((r) => label.endsWith(`:r${r}`))
      ? { findings: [finding] }
      : { findings: [] };

describe('review-loop workflow', () => {
  it('reports open findings when the fixer cannot get pnpm check green', async () => {
    const { result, summary, of } = await runLoop({
      review: reviewerFinds([1]),
      fix: () => ({ checkPassed: false, resolutions: [] }),
    });
    expect(of('post')).toHaveLength(1);
    expect(summary).toContain('⚠️');
    expect(summary).toContain('pnpm check failing after fixes');
    expect(summary).toContain('`tools/check.mjs`: Gate order hides drift');
    expect(summary).not.toContain('✅');
    expect(result).toMatchObject({
      complete: false,
      open: ['tools/check.mjs: Gate order hides drift'],
    });
  });

  it('reports open findings when it runs out of rounds', async () => {
    const { result, summary, of } = await runLoop({
      review: reviewerFinds([1]),
      fix: () => ({
        checkPassed: true,
        resolutions: [{ path: finding.path, title: finding.title, status: 'not-done' }],
      }),
    });
    expect(of('fix')).toHaveLength(2); // rounds 1 and 2; round 3 is the last review
    expect(summary).toContain('⚠️');
    expect(summary).toContain('3 rounds reached');
    expect(result.complete).toBe(false);
    expect(result.open).toHaveLength(1);
  });

  it("never re-verifies or re-posts a won't-fix finding, and still converges", async () => {
    const { result, summary, of } = await runLoop({
      review: reviewerFinds(),
      fix: () => ({
        checkPassed: true,
        resolutions: [{ path: finding.path, title: finding.title, status: 'wontfix', note: 'n/a' }],
      }),
    });
    expect(of('verify').map((c) => c.label)).toEqual([
      expect.stringMatching(/^verify:new:tools\/check\.mjs/),
    ]);
    expect(of('post')).toHaveLength(1);
    expect(of('fix')).toHaveLength(1);
    const round2 = of('review').find((c) => c.label === 'review:correctness:r2');
    expect(round2?.prompt).toContain("[won't fix — do not re-report] tools/check.mjs: Gate order");
    expect(summary).toContain('✅');
    expect(summary).toContain("**Won't fix:**");
    expect(result).toMatchObject({ complete: true, open: [] });
  });

  it('treats threads from an earlier run as known instead of posting duplicates', async () => {
    const id = findingId({ path: 'tools/a.mjs', title: 'Old finding' });
    const body = commentBody({ ...finding, path: 'tools/a.mjs', title: 'Old finding', id }, 1);
    let fixed = false;
    const thread = () => ({
      id,
      title: 'Old finding',
      path: 'tools/a.mjs',
      line: 3,
      resolved: fixed,
      wontfix: false,
      body,
    });
    const { result, summary, of } = await runLoop({
      threads: () => ({ threads: [thread()] }),
      review: ({ label }) =>
        label === 'review:tests:r1'
          ? { findings: [{ ...finding, path: 'tools/a.mjs', line: 3, title: 'Old finding' }] }
          : { findings: [] },
      fix: ({ prompt }) => {
        fixed = true;
        expect(prompt).toContain(`"threadId": "${id}"`);
        return {
          checkPassed: true,
          resolutions: [{ path: 'tools/a.mjs', title: 'Old finding', status: 'fixed' }],
        };
      },
    });
    expect(of('review')[0]?.prompt).toContain('[open] tools/a.mjs: Old finding');
    expect(of('verify')).toHaveLength(0);
    expect(of('post')).toHaveLength(0);
    expect(of('fix')).toHaveLength(1);
    expect(summary).toContain('✅');
    expect(result.complete).toBe(true);
  });

  it('runs every code-reading agent in its own worktree at the PR head', async () => {
    const { of } = await runLoop({
      review: reviewerFinds([1]),
      fix: () => ({ checkPassed: false, resolutions: [] }),
    });
    const codeAgents = [...of('review'), ...of('verify'), ...of('fix')];
    expect(codeAgents.length).toBe(6);
    for (const c of codeAgents) {
      expect(c.opts.isolation, c.label).toBe('worktree');
      expect(c.prompt, c.label).toContain(
        `git fetch -q origin "pull/7/head" && git checkout -q --detach ${SHA}`,
      );
      expect(c.prompt, c.label).toContain('LEFTHOOK=0 pnpm install --frozen-lockfile');
      expect(c.prompt, c.label).not.toMatch(/checkout --detach "origin\//);
    }
    expect(of('fix')[0]?.prompt).toContain('git push origin HEAD:refs/heads/feature');
    expect(of('fix')[0]?.prompt).not.toContain('git switch');
  });

  it('refers the tester to what the repository can actually run', async () => {
    const { of } = await runLoop();
    const tester = of('review').find((c) => c.label === 'review:tester:r1');
    expect(tester?.prompt).toContain('pnpm check --all');
    expect(tester?.prompt).toContain('open the changed pages in a browser');
    expect(tester?.prompt).not.toMatch(/pnpm dev|playwright-cli/);
  });
});
