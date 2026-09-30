#!/usr/bin/env node
// Claude Code PostToolUse hook (Bash: `gh pr create …` / `gh pr ready …`).
// When a pull request of THIS repository is opened (or a draft is marked ready), remind Claude of
// the repo's rule "phase PR → review loop → human merges": it offers the review loop and starts it
// once the user agrees. The loop spawns many agents and pushes to the PR branch, so only the user
// can skip that question: REVIEW_LOOP_AUTO=1 in their own environment (e.g. "env" in
// .claude/settings.local.json, never the committed settings) starts it right away.
// REVIEW_LOOP_AUTO=0 turns the hook off.
//
// Fires only for a PR it can name in this repository: `gh pr create` prints the new PR's URL (no
// URL of this repository = nothing was opened here: --help, --web, --dry-run, -R, another
// checkout); `gh pr ready` prints `<owner>/<repo>#<n>`, which must name this repository (and the
// number in the command, if any). Draft PRs are skipped (the loop starts on `gh pr ready`).
// Never blocks and never fails the tool call: always exits 0.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `owner/repo` (lowercase) of a GitHub remote URL, https or ssh, or undefined. */
export function githubRepo(remoteUrl) {
  const m = String(remoteUrl ?? '')
    .trim()
    .match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : undefined;
}

/** The `gh pr <sub> …` part of a command, up to the next `;`, `&`, `|` or newline. */
const segment = (command, sub) =>
  command.match(new RegExp(`(?:^|[\\s;&|(])(gh\\s+pr\\s+${sub}\\b[^;&|\\n]*)`))?.[1];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * The command with heredoc bodies removed and quoted strings emptied: what is left are its words
 * and flags (a title or body may say `-d`, `--draft` or `&`).
 */
const withoutText = (command) =>
  command
    .replace(/<<-?[ \t]*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '$3')
    .replace(/"(?:[^"\\]|\\[\s\S])*"|'[^']*'/g, '""');

/**
 * Pure: decide what to tell Claude for a Bash PostToolUse payload (or undefined = nothing).
 * `repo`: this checkout's GitHub `owner/repo`; without it the hook stays silent.
 */
export function reviewLoopContext(input, env = process.env, repo) {
  if (env.REVIEW_LOOP_AUTO === '0' || !repo) return undefined;
  if (input?.tool_name !== 'Bash') return undefined;
  const command = String(input.tool_input?.command ?? '');
  const response = input.tool_response ?? {};
  if (typeof response.exit_code === 'number' && response.exit_code !== 0) return undefined;
  const output = `${response.stdout ?? ''}\n${response.stderr ?? ''}`;

  const create = segment(command, 'create');
  const ready = create === undefined ? segment(command, 'ready') : undefined;
  let pr;
  if (create !== undefined) {
    pr = output.match(
      new RegExp(`https://github\\.com/${escapeRe(repo)}/pull/(\\d+)(?![\\w/])`, 'i'),
    )?.[1];
    // `-d`, also in a group of short flags (`-df`), or `--draft`: flags, not quoted text
    const flags = segment(withoutText(command), 'create') ?? create;
    if (pr && /\s(?:--draft\b|-[A-Za-z]*d[A-Za-z]*(?=\s|$))/.test(flags))
      return `A DRAFT pull request (#${pr}) was opened. The review loop is offered when it is marked ready (\`gh pr ready\`); do not run it now.`;
  } else if (ready !== undefined) {
    // --undo makes it a draft again; -R/--repo or a `cd` may name another repository
    if (/\s(?:--undo|-R|--repo)\b/.test(ready) || /(?:^|[\s;&|(])cd\s/.test(command))
      return undefined;
    // gh names the PR's repository in its output: a PR of the repository the command ran in,
    // which need not be this one (the working directory carries over between commands)
    pr = output.match(new RegExp(`(?:^|[\\s(])${escapeRe(repo)}#(\\d+)\\b`, 'im'))?.[1];
    const asked = ready.match(/^gh\s+pr\s+ready\s+(\d+)(?=\s|$)/)?.[1];
    if (asked && asked !== pr) return undefined;
  }
  if (!pr) return undefined;

  const run = `run the saved workflow \`review-loop-run\` with args {"pr": ${pr}} (the review-loop skill describes it)`;
  const start =
    env.REVIEW_LOOP_AUTO === '1'
      ? [
          `PR #${pr} is ready for review. REVIEW_LOOP_AUTO=1 is set: the user's opt-in to starting the review loop without`,
          `being asked. Now: ${run} and tell the user it started.`,
        ]
      : [
          `PR #${pr} is ready for review. This repository runs its review loop on every opened PR (AGENTS.md → "Pull requests").`,
          'Ask the user now whether to start it: it spawns many agents, posts review comments and pushes fixes to the PR branch.',
          `Once they agree, ${run}.`,
        ];
  return [
    ...start,
    'It reviews (3 lenses + a hands-on tester), posts findings as inline comments, fixes them, and re-reviews the fixes',
    'until no blocker/major issue is open. It works in its own git worktrees, so the user can keep working; never merge the PR.',
  ].join('\n');
}

/** `owner/repo` of the `origin` remote of the checkout at `dir`, or undefined. */
function originRepo(dir) {
  try {
    return githubRepo(
      execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return undefined;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    // the project's repository: the loop runs there, whatever directory the command ran in
    const repo = originRepo(process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd());
    const context = reviewLoopContext(input, process.env, repo);
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
