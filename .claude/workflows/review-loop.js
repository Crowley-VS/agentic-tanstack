export const meta = {
  name: 'review-loop',
  description:
    'Review a PR, post findings as inline comments, fix them, re-review until no open or new issues remain',
  whenToUse:
    'After a phase/milestone PR is opened and `pnpm check` is green. Pass args {pr: <number>, maxRounds?: 5}.',
  phases: [
    {
      title: 'Review',
      detail: '3 code reviewers (read-only) + 1 hands-on tester in its own worktree',
    },
    {
      title: 'Verify',
      detail: 'each new or reopened finding is independently checked against the code',
    },
    { title: 'Post', detail: 'confirmed findings → one GitHub review with inline comments' },
    {
      title: 'Fix',
      detail: 'fixer addresses open threads, runs pnpm check, pushes, resolves threads',
    },
    { title: 'Summary', detail: 'final PR comment with the outcome' },
  ],
};

// ---------------------------------------------------------------------------------------------
// Loop: review → verify → post → fix, until a round has no new confirmed findings AND no open
// review-loop threads, or maxRounds is hit. GitHub is the durable record (threads carry stable
// ids); this script keeps per-run memory so rejected findings are not re-litigated.
// ---------------------------------------------------------------------------------------------
const PR = args?.pr;
if (!PR) throw new Error('review-loop: pass args {pr: <number>}');
const MAX_ROUNDS = args?.maxRounds ?? 5;

const READ_ONLY = `You are READ-ONLY: do not edit, create or delete tracked files, do not commit, push or post anything.
You MAY run commands that don't modify tracked files (tests, type checks, scripts against throwaway copies in a temp dir).`;
const CONTEXT = `Repository: the current working directory (an Nx monorepo; follow AGENTS.md/CLAUDE.md, which you already have).
Pull request #${PR}. Look at the WHOLE pull request, not just the diff:
- \`gh pr view ${PR} --comments\` (description, stated goals, test plan checkboxes, discussion)
- \`gh pr checks ${PR}\` (CI status; \`gh run view <id> --log-failed\` for failures)
- \`gh pr diff ${PR}\` (what changed), then read changed files IN FULL plus the code they call or that calls them.`;

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'repo-relative file path' },
          line: {
            type: 'integer',
            description: 'line on the NEW side of the diff (omit if file-level)',
          },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          title: {
            type: 'string',
            description: 'short, specific, stable wording (reused to detect repeats)',
          },
          body: { type: 'string', description: 'what is wrong + a concrete failure scenario' },
          suggestion: { type: 'string', description: 'concrete fix' },
        },
        required: ['path', 'severity', 'title', 'body'],
      },
    },
  },
  required: ['findings'],
};

const VERDICT = {
  type: 'object',
  properties: {
    valid: { type: 'boolean' },
    reason: { type: 'string', description: 'evidence: file:line references and why' },
    severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
    duplicateOf: {
      type: 'string',
      description: 'title of an earlier finding in the list this duplicates, if any',
    },
  },
  required: ['valid', 'reason'],
};

const LENSES = [
  {
    key: 'correctness',
    prompt: `LENS: correctness and security. Bugs, wrong logic, unhandled errors and edge cases, race conditions,
resource leaks, broken CLI/config wiring, security problems (secrets, injection, unsafe defaults, over-broad permissions).`,
  },
  {
    key: 'tests',
    prompt: `LENS: tests and verification. Changed behavior without tests, tests that pass for the wrong reason or don't
assert what they claim, flaky patterns, gaps in \`pnpm check\`/CI coverage, CI workflow mistakes.`,
  },
  {
    key: 'consistency',
    prompt: `LENS: consistency and maintainability. Violations of AGENTS.md invariants and repo conventions, docs/comments
that contradict the code, agent-layer problems (hooks, permissions, skills, generated-file manifest), dead or duplicated
code, confusing names, changes outside the PR's stated scope.`,
  },
];

// The hands-on tester works in its own git worktree (isolation: 'worktree'), so it gets its own
// ports and database (tools/dev-ports.mjs) and never disturbs the main checkout.
const TESTER_PROMPT = `You are the HANDS-ON TESTER. Your job is to actually run and try the PR, not just read it.
You are in your own throwaway git worktree. Setup:
  git fetch origin && git checkout --detach "origin/$(gh pr view ${PR} --json headRefName -q .headRefName)"
  pnpm install --frozen-lockfile
Then:
1. Run \`pnpm check --all\`. Any failure is a finding (include the failing output).
2. Verify EVERY claim in the PR description and every test-plan item by doing it yourself.
3. Exercise the changed behavior the way a user or agent would: run changed scripts/CLIs with realistic and edge-case
   inputs (against throwaway copies in a temp dir when they modify files, e.g. bootstrap); start apps with
   \`pnpm dev\` (background; find URLs with \`pnpm ports\`) and drive changed pages with the playwright-cli skill
   (\`pnpm exec playwright cli …\`); check logs and console errors. Try to break it.
4. Stop any processes/containers you started before you finish.
Rules: never commit or push; never post to GitHub; anything you change in this worktree is discarded.
Report only things you actually observed, each with exact reproduction steps and observed vs expected result.
For a finding about a file, use that file's path and the most relevant line.`;

/** Title of a posted finding, parsed back out of its comment body ("**major: Title**"). */
const titleFromBody = (body) =>
  body?.match(/\*\*(?:blocker|major|minor|nit|issue): (.+?)\*\*/)?.[1];

const keyOf = (f) => `${f.path}::${String(f.title).trim().toLowerCase()}`;
const seen = new Map(); // key → { status: 'open' | 'resolved' | 'rejected', finding }
const history = [];

async function openThreads() {
  const out = await agent(
    `${CONTEXT}\nRun \`node tools/pr-review.mjs threads --pr ${PR} --all\` and return its JSON array verbatim as {threads}.`,
    {
      label: 'threads',
      phase: 'Fix',
      effort: 'low',
      schema: {
        type: 'object',
        properties: {
          threads: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                resolved: { type: 'boolean' },
                path: { type: 'string' },
                line: { type: ['integer', 'null'] },
                body: { type: 'string' },
              },
              required: ['id', 'resolved'],
            },
          },
        },
        required: ['threads'],
      },
    },
  );
  return out?.threads ?? [];
}

for (let round = 1; round <= MAX_ROUNDS; round++) {
  // ---- 1. Review (3 code lenses + hands-on tester, in parallel) ------------------------------
  phase('Review');
  const known = [...seen.values()]
    .map((s) => `- [${s.status}] ${s.finding.path}: ${s.finding.title}`)
    .join('\n');
  const rules = `Review ONLY what this PR changes (and code it directly breaks).
Report real problems with concrete evidence; skip formatting/style (oxfmt handles it) and pure preferences.
At most 8 findings, most severe first. Use a stable, specific title for each finding.
Findings already reported earlier in this loop (do NOT report them again unless a "resolved" one is still broken
in the current code — then report it again with the SAME path and title):
${known || '(none yet)'}`;
  const reviews = await parallel([
    ...LENSES.map(
      (lens) => () =>
        agent(`${READ_ONLY}\n${CONTEXT}\n\n${lens.prompt}\n\n${rules}`, {
          label: `review:${lens.key}:r${round}`,
          phase: 'Review',
          schema: FINDINGS,
        }),
    ),
    () =>
      agent(`${CONTEXT}\n\n${TESTER_PROMPT}\n\n${rules}`, {
        label: `review:tester:r${round}`,
        phase: 'Review',
        schema: FINDINGS,
        isolation: 'worktree',
      }),
  ]);
  const raw = reviews.filter(Boolean).flatMap((r) => r.findings);

  // ---- 2. Classify + verify ------------------------------------------------------------------
  const fresh = [];
  const reopenCandidates = [];
  const batchKeys = new Set();
  for (const f of raw) {
    const k = keyOf(f);
    if (batchKeys.has(k)) continue;
    batchKeys.add(k);
    const prior = seen.get(k);
    if (!prior) fresh.push(f);
    else if (prior.status === 'resolved') reopenCandidates.push(f);
    // open or rejected: ignore
  }
  log(
    `round ${round}: ${raw.length} raw, ${fresh.length} new, ${reopenCandidates.length} possibly not fixed`,
  );

  phase('Verify');
  const verify = (f, kind) =>
    agent(
      `${READ_ONLY}\n${CONTEXT}\n\nYou are a skeptical verifier. Check this ${kind === 'reopen' ? 'claim that a previously fixed issue is STILL present' : 'review finding'} against the CURRENT code on the PR branch.
Mark valid=true ONLY if you can confirm it with concrete evidence (file:line, a reproduction you ran, or an exact trace).
For findings from hands-on testing, try the reproduction steps yourself (on throwaway copies if they modify files).
If it is speculative, already handled, out of the PR's scope, or pure style, mark valid=false.
${kind === 'new' ? `Other new findings this round (set duplicateOf if this one is the same issue as an EARLIER entry):\n${fresh.map((x, i) => `${i + 1}. ${x.path}: ${x.title}`).join('\n')}` : ''}

FINDING:
${JSON.stringify(f, null, 2)}`,
      {
        label: `verify:${kind}:${f.path}:${f.title}`.slice(0, 80),
        phase: 'Verify',
        schema: VERDICT,
      },
    ).then((v) => ({ f, v }));

  const verdicts = await parallel([
    ...fresh.map((f) => () => verify(f, 'new')),
    ...reopenCandidates.map((f) => () => verify(f, 'reopen')),
  ]);
  const confirmedNew = [];
  const reopened = [];
  for (const r of verdicts.filter(Boolean)) {
    const { f, v } = r;
    const isReopen = reopenCandidates.includes(f);
    if (!v?.valid || v.duplicateOf) {
      if (!isReopen) seen.set(keyOf(f), { status: 'rejected', finding: f });
      continue;
    }
    const finding = { ...f, severity: v.severity ?? f.severity };
    if (isReopen) reopened.push({ ...finding, reason: v.reason });
    else confirmedNew.push(finding);
  }

  // ---- 3. Post -------------------------------------------------------------------------------
  phase('Post');
  if (confirmedNew.length || reopened.length) {
    const reopenNote = reopened.length
      ? `\nAlso, these previously resolved findings are STILL present — include them in the same post (same path/title, body prefixed with "Still present: " and the reason):\n${JSON.stringify(reopened, null, 2)}`
      : '';
    await agent(
      `${CONTEXT}\nPost these review findings to the PR by piping the JSON array to:
\`node tools/pr-review.mjs post --pr ${PR} --round ${round}\` (use a heredoc: <<'JSON' ... JSON).
Do not change the findings' wording. Report the command output.
FINDINGS:
${JSON.stringify(confirmedNew, null, 2)}${reopenNote}`,
      { label: `post:r${round}`, phase: 'Post', effort: 'low' },
    );
  }
  for (const f of [...confirmedNew, ...reopened])
    seen.set(keyOf(f), { status: 'open', finding: f });

  // ---- 4. Stop condition ---------------------------------------------------------------------
  // Open work = findings this run still has open + unresolved review-loop threads on GitHub
  // (threads can pre-date this run). Body-level findings have no thread, so memory matters.
  const threads = await openThreads();
  const openThreadList = threads.filter((t) => !t.resolved);
  const openByKey = new Map();
  for (const s of seen.values())
    if (s.status === 'open') openByKey.set(keyOf(s.finding), { ...s.finding });
  for (const t of openThreadList) {
    const title = titleFromBody(t.body);
    const k = title ? keyOf({ path: t.path, title }) : `thread::${t.id}`;
    openByKey.set(k, {
      ...(openByKey.get(k) ?? { path: t.path, line: t.line, title, body: t.body }),
      threadId: t.id,
    });
  }
  const open = [...openByKey.values()];
  history.push({
    round,
    raw: raw.length,
    posted: confirmedNew.length,
    reopened: reopened.length,
    open: open.length,
  });
  log(
    `round ${round}: posted ${confirmedNew.length}, reopened ${reopened.length}, open threads ${open.length}`,
  );
  if (confirmedNew.length === 0 && reopened.length === 0 && open.length === 0) break;
  if (round === MAX_ROUNDS) {
    log(`stopping after ${MAX_ROUNDS} rounds with ${open.length} open thread(s)`);
    break;
  }

  // ---- 5. Fix --------------------------------------------------------------------------------
  phase('Fix');
  const fix = await agent(
    `${CONTEXT}\n\nYou are the FIXER for review-loop round ${round}. Open findings (JSON; "threadId" = has a GitHub review thread):
${JSON.stringify(open, null, 2)}

1. You are in your OWN throwaway git worktree (the user's checkout is never touched). Check out the PR head, detached:
   \`git fetch origin && git checkout --detach "origin/$(gh pr view ${PR} --json headRefName -q .headRefName)"\`
   then \`pnpm install --frozen-lockfile\`.
2. Address EVERY open finding. Prefer a real fix. Only if a finding is wrong or out of scope, mark it "wontfix" with a specific, evidence-based note.
   Follow AGENTS.md (never hand-edit generated files; regenerate instead; add or adjust tests for behavior you change).
3. Run \`pnpm check\` until it passes. Never weaken a test or rule to make it pass.
4. Commit (conventional commit message listing the finding ids, ending with the repo's Co-Authored-By line if the repo uses one)
   and push to the PR branch: \`git push origin "HEAD:$(gh pr view ${PR} --json headRefName -q .headRefName)"\`.
   If the push is rejected because the branch moved, \`git fetch\`, rebase onto it, re-run \`pnpm check\`, and push again.
5. Resolve the threads: pipe [{"id","status":"fixed"|"wontfix","note"}] for findings WITH a threadId to
   \`node tools/pr-review.mjs resolve --pr ${PR} --commit <sha>\` (get each thread's review-loop "id" from
   \`node tools/pr-review.mjs threads --pr ${PR}\`). Findings without a thread need no GitHub call.
Return one resolution per finding (path + title exactly as given).`,
    {
      label: `fix:r${round}`,
      phase: 'Fix',
      isolation: 'worktree',
      schema: {
        type: 'object',
        properties: {
          commit: { type: 'string' },
          checkPassed: { type: 'boolean' },
          resolutions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string', enum: ['fixed', 'wontfix', 'not-done'] },
                note: { type: 'string' },
              },
              required: ['path', 'title', 'status'],
            },
          },
        },
        required: ['checkPassed', 'resolutions'],
      },
    },
  );
  if (!fix?.checkPassed) {
    log(`round ${round}: fixer could not get pnpm check green — stopping for a human`);
    history.push({ round, stoppedBy: 'pnpm check failing after fixes' });
    break;
  }
  for (const r of fix.resolutions ?? []) {
    if (r.status === 'not-done') continue;
    const k = keyOf(r);
    seen.set(k, { status: 'resolved', finding: seen.get(k)?.finding ?? r });
  }
}

// ---- Summary ---------------------------------------------------------------------------------
phase('Summary');
const finalThreads = await openThreads();
const stillOpen = finalThreads.filter((t) => !t.resolved);
const table = history
  .map((h) =>
    h.stoppedBy
      ? `| ${h.round} | stopped: ${h.stoppedBy} | | | |`
      : `| ${h.round} | ${h.raw} | ${h.posted} | ${h.reopened} | ${h.open} |`,
  )
  .join('\n');
const verdict =
  stillOpen.length === 0
    ? '✅ **Review loop complete** — no open or new issues.'
    : `⚠️ **Review loop stopped with ${stillOpen.length} open thread(s)** — needs a human look.`;
await agent(
  `${CONTEXT}\nPost this markdown as a PR comment by piping it to \`node tools/pr-review.mjs comment --pr ${PR}\` (heredoc). Post it verbatim.

${verdict}

| Round | Raw findings | Posted | Reopened | Open threads after round |
| --- | --- | --- | --- | --- |
${table}

<sub>Posted by the review-loop workflow (\`.claude/workflows/review-loop.js\`).</sub>`,
  { label: 'summary', phase: 'Summary', effort: 'low' },
);
return { pr: PR, rounds: history, open: stillOpen.map((t) => t.id) };
