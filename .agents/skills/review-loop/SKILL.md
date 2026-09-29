---
name: review-loop
description: Use after a phase/milestone PR is opened and `pnpm check` is green — runs review → post inline findings → fix → re-review until no open or new issues remain.
---

# Review loop for a pull request

## When

A phase of work is done, `pnpm check` passes, and a PR is open (`gh pr create`). Run the loop before asking a
human to merge. The human still merges; the loop never merges.

## How (Claude Code)

Run the saved workflow **`review-loop`** with `args: { pr: <number> }` (optional `maxRounds`, default 5).
Workflows spawn many agents, so confirm with the user first if they haven't already asked for the loop.

Each round:

1. **Review**: three read-only reviewers (correctness+security, tests+verification, consistency/agent-layer) read
   the WHOLE PR (description, test plan, CI status, comments, full changed files). A **hands-on tester** runs
   `pnpm check --all`, verifies every claim in the description, and actually exercises the change (scripts on
   throwaway copies; for app changes it runs the app and clicks through the changed pages in a browser).
2. **Verify**: each new finding is independently checked against the code (false positives dropped).
3. **Post**: confirmed findings become one GitHub review with inline comments (`tools/pr-review.mjs post`).
4. **Fix**: a fixer addresses every open finding (or replies with an evidence-based won't-fix), runs
   `pnpm check`, commits, pushes to the PR branch, and resolves the threads.

Every agent that reads or changes code works in its own git worktree checked out at the PR head (own ports and
database), so the main checkout is never touched. It stops when a round finds **no new issues and nothing is
open**, then posts a summary comment (⚠️ with the open findings if it stopped for any other reason).

## Manual fallback (other agents / no workflows)

```bash
gh pr view <n> --comments && gh pr checks <n> && gh pr diff <n>   # review the whole PR
node tools/pr-review.mjs post --pr <n> --round 1 <<'JSON'         # post findings
[{"path":"tools/x.mjs","line":12,"severity":"major","title":"…","body":"…","suggestion":"…"}]
JSON
node tools/pr-review.mjs threads --pr <n>                          # list open review-loop threads
node tools/pr-review.mjs resolve --pr <n> --commit <sha> <<'JSON'  # after fixing + pushing
[{"id":"rl-…","status":"fixed","note":"…"}]
JSON
```

Repeat review → fix until nothing new is found and `threads` is empty.

## Notes

- Posts as your `gh` user. GitHub doesn't let you approve your own PR, so reviews are posted as comments.
- Only threads started by your `gh` user count as review-loop findings (anyone can comment on a PR).
- `post`, `resolve` and `comment` write to GitHub, so Claude Code asks before running them.
- Finding ids are stable (`rl-<hash of path + title>`), so repeats are detected across rounds; won't-fix
  findings are not raised again.
