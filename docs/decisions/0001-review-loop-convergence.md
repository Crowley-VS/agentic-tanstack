# 0001 — Review loop: why it did not converge on PR #1, and what changed

- **Status:** accepted (2026-09-30); amended the same day after the loop ran on PRs #3 and #4 (section 6)
- **Context:** the `review-loop-run` workflow ran twice on PR #1 (M1 workspace skeleton + the loop itself) and
  never reached ✅. Run 1: 5 rounds, 93 findings posted, 153 agents, ~13M tokens. Run 2 (redesigned: fixes-only
  follow-up rounds, blocker/major gate, batched verification): 34 agents, ~4.5M tokens, ended by `/tmp` inode
  exhaustion in round 3.
- **Method:** four read-only analysts (finding provenance via `git blame`, taxonomy + strict severity re-grade,
  fixer/verifier quality with spot checks, process/cost with stop-rule simulations) and a synthesizer, over the
  PR's 116 findings, 123 reviews, 10 fix commits and both run journals. Raw data stays local
  (`.agents/ignore/retro/`).
- **Correction after the retro:** the claimed ongoing `/tmp` leak from `tools/check.mjs --nx-agents` did not
  reproduce in the main checkout (inode delta 1 per run) once the check used local Nx files; the worktree case is
  guarded anyway (private TMPDIR, pre-flight disk check).

# Review loop on PR #1: retrospective (runs 1 and 2)

Sources: four analysts. [A1] traced where each finding came from with git blame. [A2] classified the findings and re-graded their severity strictly. [A3] studied fix and verification quality. [A4] studied process, cost and simulated stop rules. I also checked two things myself: `run2-journal.jsonl` for round 3, and `.claude/workflows/review-loop-run.js` at HEAD `cf77710` (line numbers below refer to that file).

## TL;DR

- **Run 1 could not converge.** Every round re-reviewed the whole PR, so later rounds kept finding code that had been there since round 1: 49 of 72 findings in rounds 2-5 (68%). Confirmed findings per round went 22, 19, 20, 18, 15, only about 10% decay a round.
- **Run 2 fixed that, and converged on findings, but not on its stop gate.** Pre-existing code no longer came back (0 of 20 later findings). Round 3 had **0 new blocker/major**. The run still did not end, for three reasons:
  - The fixer's changes for _minor_ findings produced the blocking findings.
  - The tester reported failures that no agent could fix (stale test counts in the PR description, checks that need a repo variable). Every such failure blocks ✅, so ✅ was impossible.
  - /tmp ran out of inodes during the posting step.
- **PR #1 was a worst case.** The loop reviewed and rewrote its own code while running the version it started with. Loop code grew from 24% to 43% of the PR, and 91% of run 2's findings were about the loop.

## 1. Root causes, ranked by impact

The causes overlap and are not additive. For example, findings about the loop's own code split 19 caused by a fix and 20 pre-existing [A1].

1. **Review scope (run 1): every round re-reviewed the whole PR, and round 1 was capped.**
   - 49 of 72 findings in rounds 2-5 (68%) were about code already present at round 1. So were 13 of the 22 blocking findings from round 2 on [A1].
   - All 4 round-1 reviewers returned exactly the 8-finding maximum [A1, A4].
   - Examples: 'CI grants only contents:read, so nx-set-shas fails on every push to main', 'Bootstrap leaves an Nx daemon running that makes the first real pnpm check fail', 'Allow rules `pnpm nx run/run-many/affected *` auto-approve arbitrary shell commands via --command/--args'.
2. **The fixer fixes everything and adds new mechanisms (both runs; the redesign did not fix this).**
   - It marked 114 of 118 findings fixed and never used won't-fix [A3].
   - The fix commits added +5,192 lines in run 1 (equal to 60% of the lines the original PR added) and +1,344 in run 2 [A1].
   - 30 of the 83 findings from round 2 on were caused by the preceding fix; 15 of those were regressions [A1].
   - In run 2, all 13 new follow-up findings sit in code the fixer had just written. 11 of them came from fixes to _minor_ findings, including all 3 new majors in round 2. 28 of 35 run-2 fixes were for minor or nit findings [A3].
   - Some fixes set off chains of follow-ups: the pre-commit skill sync led to 6 (4 major), and the tester-gap logic to 8 or more [A1].
   - Examples: 'A fix pass that pushes nothing converges with ✅ when the fixer marks blocking findings fixed' (from a minor fix) and 'On Windows, bootstrap's git commit goes through cmd.exe unquoted' (from the Windows fix). For 'pr-opened hook claims a standing opt-in', the verifier scoped the fix to wording, but the fixer reversed 356d1b4's auto-start design [A3].
   - Where it lives: the fix prompt (~l.771) passes `open` (every severity), not `openBlocking`. The header (l.34-35) says minor findings are "addressed in the same fix pass". The minimal-fix rule exists only in the prompt.
3. **The loop reviewed its own machinery in the same PR.**
   - 39 of 83 findings from round 2 on (47%) [A1], and 52 of 109 unique findings (48%) [A2], were about the loop.
   - In run 2 that was 21 of 23 inline findings (91%) and 7 of 7 blocking ones [A4].
   - Loop code grew from 832 to 3,969 lines; the workflow from 376 to 946 lines.
   - The run executed the version it started with (356d1b4), so the fixes to its gating could not take effect mid-run. Severity was null in 0/108 and 0/119 relayed thread rows [A3].
   - Examples: 'Threads from an earlier run carry no severity…', 'Every tester fail is a gap whatever its severity', 'Worktree agents check out the PR head, so their worktrees are never auto-removed'.
4. **Severity inflation, and a verifier that does not filter on value.**
   - 63 of 109 findings (58%) were posted above a strict "does it break a real flow?" grade. Only 12 of 36 blocker/major labels survive that grade: 1 of 7 in run 2 [A2].
   - The rubric itself inflates: at l.132 it defines major as including "changed behavior with no test". That is how 'Fix-phase stop … has no test' was posted as major.
   - Verifiers rejected 3 of 165 findings (1.8%), none as factually wrong [A3, A4]. rl-1ff98de4 was posted major, then minor, then major [A2].
   - One thing did work: downgrades turned 15 raw majors in run 2 round 1 into 3 confirmed blocking findings [A4].
5. **Gates that no agent can satisfy.**
   - Any tester fail or could-not-run becomes a gap (l.537-553). The tester is told to "Verify EVERY claim in the PR description" (l.217).
   - 'Test plan: 17 validators tests, 134 tools tests and 6 bootstrap tests' was a FAIL in all 3 run-2 rounds, because each fix adds tests (the tools count went 81 → 195). The fixer returned not-done 4 of 4 times on the PR description.
   - 'template smoke test (needs TEMPLATE_MAINTENANCE=true)' and 'the lefthook hooks ran on these commits' could not run.
   - Commit 56e21a4 made every tester fail a gap. Under 356d1b4 (the code that ran), ✅ was structurally impossible, and a successful round-3 post would likely have run about 2 more rounds: roughly 16 agents and 2.5M tokens [A4].
6. **Infrastructure and relay fragility ended run 2.**
   - /tmp had 1,048,576 of 1,048,576 inodes used. 235,476 of them (22.5%) are 93 dirs leaked by `tools/check.mjs --nx-agents`, which still leaks after cf77710 (a 5-line prompt change only).
   - The posting step's ENOSPC error was not recoverable, even though every finding carries a stable rl-id that would allow a safe retry.
   - About 150 of run 2's 276 minutes (55%) were a stall between the fix commit and thread resolution, consistent with waiting on permission prompts.
   - Agents that only relay CLI output returned severity null in 94/94, 108/108 and 119/119 thread rows. Run 1's summary reported 22/38/40/36/30 open findings when the actual unresolved counts were 22/19/20/18/15 [A4].

## Contradictions between analysts, resolved

- **Does fix size predict the next round's findings?** [A4] measured 1.2-1.65 findings per 100 added lines. [A1] found r=0.27 at the round level. In run 1, [A4]'s ratio is mostly discovery of old code (68%), not fallout from the fix. What does predict findings is non-test _source_ lines: per-file rank correlation 0.73 in run 2, and about 1 fix-caused finding per 1k test lines versus 38-41 per 1k lines of loop source. **Budget non-test source lines; do not use total diff size as a stop signal.**
- **Share of later run-1 findings on code a fix wrote:** 32% ([A1], judged by mechanism, 23 of 72), 41% ([A2], blame, 29 of 71), 43% ([A4], blame). Blame over-counts when fixes move lines ([A1]'s manual reading agreed with blame on 79%). Use about 32%, with 43% as an upper bound.
- **Run 2 round 3:** the analysts say "9 verified" [A1], "9 raw, all confirmed" [A2] and "6 new + 1 reopen" [A4]. The journal shows 9 raw findings and 9 valid verdicts. The verifiers flagged 1 as a known finding (a reopen) and 1 as a duplicate within the round, and [A3] found one more missed duplicate. That leaves 6-7 distinct findings and **0 blocker/major** (the tester's major was downgraded to minor). Everyone agrees there were 0 blocking.
- **Did run 2 converge?** [A2] says effectively yes, [A4] says not under 356d1b4, [A1] says it cannot be determined. It converged on _findings_, not on the _gate_. Under 356d1b4, tester gaps would have pushed it toward maxRounds. Under HEAD it would have run one suggestions-only fix pass and stopped with ⚠️. ✅ was impossible under either version.
- **Verifier value:** [A4] says it barely filtered; [A3] says it is accurate. Both hold. It is factually reliable (0 of 165 findings rejected as wrong; 13 of 13 spot checks held) but weak on value and severity. Its real effect on the gate came from downgrades and deduplication.
- **Tester value:** [A4] reports low yield (46% and 33% of its findings survived); [A3] reports high value. In run 1 its unique finds were among the worst real bugs: 'Bootstrap leaves an Nx daemon running…', 'Fresh clones get no git hooks…', and the '--graph=<file>' write. In run 2 it tested mocked loop logic and claims no one could fix, and 8 of its 12 findings were duplicates. Keep it and re-aim it.
- **Exclude the loop's files?** [A1] and [A2] say yes. [A4] shows this would have stopped run 2 after round 1 but left 4 blocking loop bugs unreviewed ([A2] rates only 1 of them strictly major). Do not exclude them silently. Put loop changes in their own PR with human review, and have the loop refuse to fix itself.

## 2. What run 2 fixed, and what it did not

| Metric                                    | Run 1               | Run 2                                         |
| ----------------------------------------- | ------------------- | --------------------------------------------- |
| Agents / tokens                           | 153 / ~13M          | 34 / ~4.5M (-65%)                             |
| Verifier agents                           | 117 (76% of agents) | 9 (26%), evidence kept (47/48 cite file:line) |
| Later-round findings on pre-existing code | 49/72               | **0/20**                                      |
| New blocker/major per round               | 9, 7, 8, 4, 3       | 3, 4, **0**                                   |
| Lines added per fix                       | 58-75               | 36-43                                         |

**Not fixed:**

- Won't-fix was used 0 times in both runs.
- Findings caused by the previous fix, per 1k lines it added, rose from 3.3-4.8 to 12.6-27.8.
- The share of findings about the loop itself rose from 38% to 94%.
- Only 1 of 7 blocking findings in run 2 is blocking under a strict grade.
- Tokens per blocking finding rose from ~419k to ~643k.
- The tester-gate problem got worse (56e21a4).
- The stop rule never fired: it needs `round >= 3` (l.737), and run 2's open blocking went 3 → 4 in round 2.
- The /tmp leak and relay fragility remain.
- **New risk: the round-1 cap is still 8 (l.488), but later rounds no longer make up for what round 1 misses.** In run 1, rounds 2-5 surfaced 13 blocking issues in pre-existing code. Fixes-only scope would never find these.

## 3. Changes (details in `changes`)

- **P0**
  - The fixer handles blocker/major findings only.
  - Strict severity rubric.
  - Tester results "needs-human" and "n/a", and no exact test counts.
  - Fix the /tmp leak and add an inode pre-flight check.
- **P1**
  - Stop rule from round 2, and maxRounds 3.
  - Refuse to self-fix PRs that touch the loop.
  - Mechanical minimal-fix budget.
  - Escalate to a human on a second reopen.
  - Better round-1 recall.
  - Idempotent posting.
  - Deterministic relays.
- **P2**
  - Theme and cross-batch deduplication.
  - Re-aim the tester.
  - Restructure the verifier.
  - Telemetry.
  - Permission-gate UX.

**Simulated on run 2:**

- Starting the "not decreasing" rule at round 2 stops the run there (open blocking 3 → 4). It misses 0 of 7 blocking findings and saves ~8 agents, ~1.2M tokens and ~26 minutes.
- Fixing only blocking findings: 11 of 13 follow-ups, including all 3 new round-2 majors, would not have been written. The re-posted 'A tester fail result never blocks ✅' (graded minor in round 1) would not have been reopened. That puts round 2 at about 0 new blocking, so the run stops after round 2. This is a counterfactual.
- A strict rubric takes run 2 from 7 blocking findings to 1.
- A needs-human bucket removes the fail that recurred in all 3 rounds and makes ✅ reachable.
- **Combined:** about 26 agents and ~3.4M tokens, and about 100 minutes without the stall, versus 34+ agents, 4.5M tokens and 276 minutes. It misses 0 of the 1 strictly blocking finding.
- For reference on run 1's design, [A4] simulated the "not decreasing" rule stopping at round 3: 36% fewer agents, but 7 of 31 blocking findings missed.

## 4. Process guidelines

See `guidelines`. In short:

- One concern per PR, and never let the loop fix the loop.
- Keep PRs to roughly 1,500 or fewer non-lockfile added lines and about 25 files.
- Keep exact test counts out of PR descriptions.
- Run at most 3 rounds, about 40 agents and about 5M tokens.
- A human always steps in after round 2, on a second reopen, when a fix goes over budget, or on an infrastructure error.
- For PR #1 now: stop the loop and review the loop code by hand. Then decide the 9 open items (2 about the PR description, plus 7 unposted round-3 minor/nit findings such as 'pendingTests keys hands-on checks by claimOrArea alone…'). Fix the check.mjs leak before merging.

## 5. Uncertain

- All the simulations are counterfactual, especially "fix only blocking findings". They assume later findings do not depend on earlier decisions.
- Tokens and time per phase are estimates. The journals have no usage or timestamp fields.
- Round-1 recall under the new design has not been tested on a fresh PR. Run 2's round 1 reviewed code that had already been reviewed 5 times. Whether the 8-finding cap or reviewer variance caused the spillover cannot be determined.
- The strict severity grades are [A2]'s reading; no one re-ran the reproductions.
- About 813k inodes (78%) are unattributed. The cause of the 150-minute stall is unconfirmed.
- How far this generalizes is unknown. PR #1 was 43% loop code, and product phase PRs have not been tested: the validators package, the only product code, drew just 2 nits.

## 6. Follow-up: PRs #3 and #4 (2026-09-30)

The P0 loop ran on PR #4 (M2 data layer, +2,246 lines). The loop at session start ran on PR #3 (this retrospective's
changes) by mistake, because a named workflow resolves to the version loaded when the session started.

| Run                    | Blocking in round 1        | What later rounds found                                                      | Cost                            |
| ---------------------- | -------------------------- | ---------------------------------------------------------------------------- | ------------------------------- |
| PR #1 run 1 (whole PR) | 9                          | 13 blocking in code round 1 missed (5, 5, 2, 1 per round), 8 caused by fixes | 153 agents, ~13M tokens, 4 h    |
| PR #1 run 2 (fixes)    | 3                          | 4 blocking, all in code the fixer wrote for minor findings                   | 34 agents, ~4.5M tokens, 4.6 h  |
| PR #3 (old loop)       | 1 of 15                    | 0 blocking: 4 minor caused by the fixes, 1 incomplete fix                    | 27 agents, ~2.8M tokens, 59 min |
| PR #4 (P0 loop)        | 1 of 16 (real: CI was red) | round 2, stopped half-way: 0 blocking, 2 minor about the fix                 | 22 agents, ~2.0M tokens, 42 min |

- **Round 1 carries the value.** On PRs #3 and #4 every blocking finding came from round 1. On PR #4 it was the
  reason CI was red: two test tasks raced a cold `docker compose up`. The hands-on tester found it and the fixer
  reproduced it. The fix was +43/-3, of which 19 lines were outside tests. Later rounds found real misses only when
  they re-reviewed the whole PR (PR #1 run 1), because every round-1 reviewer had hit the 8-finding cap.
- **Re-review rounds mostly review the loop's own fixes.** When the fixer wrote a lot (fixing minors), they found its
  regressions. When the fix was small and blocking-only (PR #4), four reviewers plus a tester (~0.5M tokens so far)
  found nothing blocking.
- **The P0 gate contradicted the P0 fixer.** Any failed hands-on check blocked ✅, but the fixer may only fix blocking
  findings. PR #4 had 8 failed checks, and 7 were tied to minor/nit findings, so the run could never end ✅.
- **Relay agents cost ~40k tokens each**: head, files, threads, disk and post. That is about 20% of a round, just to
  pass a command's output through.

**Changes (in the loop, `pr-review.mjs` and the skill):**

- **Round 1:** reviewers report every blocker/major finding, plus at most 8 minor/nit each. The tester starts from
  CI and turns failed checks into findings with their cause.
- **After a fix pass:** one fix checker runs instead of a review round. It reproduces each fixed finding, waits for
  CI, runs `pnpm check --all` and reads only the fix diff. A fix adding more than `fixBudget` (150) non-test lines,
  or one of unknown size, still gets the follow-up review by all four.
- **Same-head retries:** at the same head, only the agents that gave no answer run again.
- **Failed checks weigh what their finding weighs.** Each failed check names the finding it produced and blocks only
  when that finding does. It stays blocking when the finding is unknown, not judged yet or not named.
- **Fewer relay agents:** one `pr-review.mjs state` call replaces the head, files, threads and disk relays, and
  `post --list` returns the threads after posting. On a one-fix run that is 5 relays instead of 11.

**Still open:**

- Round-1 recall without the cap is untested on a fresh PR.
- A re-run on a PR the loop already reviewed still starts with a full round 1. Starting from the last loop review
  (checking only the commits since) would make resuming cheap.
