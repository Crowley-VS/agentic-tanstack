#!/usr/bin/env node
// Deterministic GitHub plumbing for the review loop (.claude/workflows/review-loop.js).
// Agents call these subcommands instead of improvising `gh api` requests.
//
//   node tools/pr-review.mjs info    --pr <n>                      PR metadata (JSON)
//   node tools/pr-review.mjs post    --pr <n> --round <r>   < findings.json
//        findings: [{ id?, path, line?, severity, title, body, suggestion? }]
//        → one PR review (event COMMENT) with inline comments on diff lines; findings that
//          can't be anchored to a changed line go into the review body. Prints posted ids.
//   node tools/pr-review.mjs threads --pr <n> [--all]              review-loop threads (JSON)
//        → [{ id, title, path, line, resolved, wontfix, body, ... }], only threads YOU started
//   node tools/pr-review.mjs resolve --pr <n> --commit <sha>  < resolutions.json
//        resolutions: [{ id, status: "fixed" | "wontfix", note }]
//        → replies on every open thread with that id and resolves it.
//   node tools/pr-review.mjs comment --pr <n>                 < markdown   plain PR comment
//
// Every comment ends with a hidden marker `<!-- review-loop:id=<id> -->` so later rounds can
// find, dedupe and resolve their own threads. Posting uses your `gh` login, and only threads
// whose first comment is by that login count: anyone can comment on a PR, and thread bodies
// are handed to an agent that edits, commits and pushes. `--pr` must be a number, so every
// command targets a pull request in the current repository.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER = 'review-loop:id=';
const WONTFIX_REPLY = "**Won't fix.**";

/** Stable id for a finding: same file + same title → same id across rounds. */
export function findingId(finding) {
  const key = `${finding.path ?? ''}::${String(finding.title ?? '')
    .trim()
    .toLowerCase()}`;
  return `rl-${createHash('sha256').update(key).digest('hex').slice(0, 8)}`;
}

/**
 * Parse a unified diff into { path → Set(line numbers on the RIGHT side that can take a comment) }.
 * Added and context lines inside hunks are commentable; removed lines are not.
 */
export function commentableLines(diff) {
  const map = new Map();
  let path;
  let right = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      path = p === '/dev/null' ? undefined : p.replace(/^b\//, '');
      if (path && !map.has(path)) map.set(path, new Set());
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('diff --git') || line.startsWith('index '))
      continue;
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      right = Number(hunk[1]);
      continue;
    }
    if (!path) continue;
    if (line.startsWith('+') || line.startsWith(' ')) {
      map.get(path).add(right);
      right++;
    }
    // '-' lines and '\ No newline' do not advance the right side
  }
  return map;
}

/** Nearest commentable line in the same file (so a slightly-off line still anchors inline). */
export function anchorLine(lines, wanted) {
  if (!lines || lines.size === 0) return undefined;
  if (wanted && lines.has(wanted)) return wanted;
  if (!wanted) return undefined;
  let best;
  for (const l of lines)
    if (best === undefined || Math.abs(l - wanted) < Math.abs(best - wanted)) best = l;
  return best !== undefined && Math.abs(best - wanted) <= 5 ? best : undefined;
}

const SEVERITY_ICON = { blocker: '🛑', major: '🟠', minor: '🟡', nit: '⚪' };

export function commentBody(f, round) {
  return [
    `${SEVERITY_ICON[f.severity] ?? '•'} **${f.severity ?? 'issue'}: ${f.title}**`,
    '',
    f.body,
    f.suggestion ? `\n**Suggested fix:** ${f.suggestion}` : '',
    '',
    `<sub>review-loop round ${round} · \`${f.id}\`</sub>`,
    `<!-- ${MARKER}${f.id} -->`,
  ]
    .filter((x) => x !== undefined)
    .join('\n')
    .trim();
}

/** The finding id from the marker that `commentBody` puts on a comment's LAST line (quotes of it in the text don't count). */
export function markerId(body) {
  return String(body ?? '').match(/<!-- review-loop:id=(rl-[0-9a-f]+) -->\s*$/)?.[1];
}

/** The finding title that `commentBody` put on a comment's first line (`<icon> **<severity>: <title>**`). */
export function titleFromBody(body) {
  const first = String(body ?? '').split('\n', 1)[0] ?? '';
  return first.match(/\*\*[a-z]+: (.+)\*\*\s*$/)?.[1];
}

/** Validate `--pr`: a pull request NUMBER (a URL or `owner/repo#n` could target another repository). */
export function prNumber(value) {
  if (!/^[1-9]\d*$/.test(String(value ?? '')))
    throw new Error(`--pr must be a pull request number in this repository (got "${value ?? ''}")`);
  return Number(value);
}

/**
 * Pure: the review-loop threads in a `reviewThreads` GraphQL response (`data` of THREADS_QUERY).
 * Only threads whose first comment was written by the viewer (the `gh` user running the loop) and
 * carries a review-loop marker count. `wontfix` = the viewer's latest reply is a won't-fix.
 */
export function parseThreads(data, { all = false } = {}) {
  const viewer = data?.viewer?.login;
  const nodes = data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const out = [];
  if (!viewer) return out;
  for (const t of nodes) {
    const comments = t.comments?.nodes ?? [];
    const first = comments[0];
    if (!first || first.author?.login !== viewer) continue;
    const id = markerId(first.body);
    if (!id || (t.isResolved && !all)) continue;
    const lastReply = comments
      .slice(1)
      .filter((c) => c.author?.login === viewer)
      .at(-1);
    out.push({
      id,
      threadId: t.id,
      commentId: first.databaseId,
      resolved: t.isResolved,
      wontfix: Boolean(lastReply?.body?.startsWith(WONTFIX_REPLY)),
      path: t.path,
      line: t.line,
      title: titleFromBody(first.body),
      body: first.body,
    });
  }
  return out;
}

/** Pure: the reply + resolve for EVERY unresolved thread carrying each resolution's id. */
export function planResolutions(resolutions, openThreads, commit) {
  const plan = [];
  for (const r of resolutions) {
    if (r.status !== 'fixed' && r.status !== 'wontfix') continue;
    const verb = r.status === 'wontfix' ? WONTFIX_REPLY : `**Addressed in ${commit.slice(0, 7)}.**`;
    for (const t of openThreads) {
      if (t.id !== r.id || t.resolved) continue;
      plan.push({
        id: r.id,
        threadId: t.threadId,
        commentId: t.commentId,
        body: `${verb} ${r.note ?? ''}`.trim(),
      });
    }
  }
  return plan;
}

/** Build the GitHub review payload from findings and the PR diff. Pure. */
export function buildReview({ findings, diff, round, commitId }) {
  const lines = commentableLines(diff);
  const inline = [];
  const unanchored = [];
  for (const raw of findings) {
    const f = { ...raw, id: raw.id ?? findingId(raw) };
    const line = anchorLine(lines.get(f.path), f.line);
    if (line) inline.push({ path: f.path, line, side: 'RIGHT', body: commentBody(f, round) });
    else unanchored.push(f);
  }
  const body = [
    `### 🔁 Review loop — round ${round}`,
    findings.length === 0
      ? 'No new issues found.'
      : `${findings.length} new finding(s): ${inline.length} inline, ${unanchored.length} below.`,
    ...unanchored.map(
      (f) =>
        `\n---\n${commentBody(f, round)}${f.path ? `\n\n\`${f.path}${f.line ? `:${f.line}` : ''}\`` : ''}`,
    ),
  ].join('\n');
  return { commit_id: commitId, event: 'COMMENT', body, comments: inline };
}

// ---------- gh helpers ----------
function gh(args, input) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}

function repoSlug() {
  return JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
}

function prInfo(pr) {
  return JSON.parse(
    gh([
      'pr',
      'view',
      String(pr),
      '--json',
      'number,url,headRefName,headRefOid,baseRefName,state,title',
    ]),
  );
}

const THREADS_QUERY = `query($owner:String!,$name:String!,$pr:Int!){viewer{login} repository(owner:$owner,name:$name){pullRequest(number:$pr){reviewThreads(first:100){nodes{id isResolved path line comments(first:50){nodes{databaseId body author{login}}}}}}}}`;

function threads(pr, all = false) {
  const [owner, name] = repoSlug().split('/');
  const res = JSON.parse(
    gh([
      'api',
      'graphql',
      '-f',
      `query=${THREADS_QUERY}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
      '-F',
      `pr=${pr}`,
    ]),
  );
  return parseThreads(res.data, { all });
}

function readStdinJson() {
  const text = readFileSync(0, 'utf8').trim();
  return text ? JSON.parse(text) : [];
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

// ---------- CLI ----------
function main(argv) {
  const [cmd] = argv;
  const known = ['info', 'post', 'threads', 'resolve', 'comment'];
  const pr = known.includes(cmd) ? prNumber(arg(argv, 'pr')) : undefined;
  switch (cmd) {
    case 'info':
      console.log(JSON.stringify(prInfo(pr), null, 2));
      return;
    case 'post': {
      const round = Number(arg(argv, 'round') ?? 1);
      const findings = readStdinJson();
      const info = prInfo(pr);
      const diff = gh(['pr', 'diff', String(pr)]);
      const review = buildReview({ findings, diff, round, commitId: info.headRefOid });
      gh(
        ['api', `repos/${repoSlug()}/pulls/${pr}/reviews`, '-X', 'POST', '--input', '-'],
        JSON.stringify(review),
      );
      console.log(
        JSON.stringify({
          posted: findings.map((f) => f.id ?? findingId(f)),
          inline: review.comments.length,
        }),
      );
      return;
    }
    case 'threads':
      console.log(JSON.stringify(threads(pr, argv.includes('--all')), null, 2));
      return;
    case 'resolve': {
      const commit = arg(argv, 'commit');
      if (!/^[0-9a-f]{7,40}$/i.test(commit ?? ''))
        throw new Error(
          '--commit <sha> is required (the pushed commit that addresses the findings)',
        );
      const plan = planResolutions(readStdinJson(), threads(pr), commit);
      const slug = repoSlug();
      for (const p of plan) {
        gh([
          'api',
          `repos/${slug}/pulls/${pr}/comments/${p.commentId}/replies`,
          '-X',
          'POST',
          '-f',
          `body=${p.body}`,
        ]);
        gh([
          'api',
          'graphql',
          '-f',
          'query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}',
          '-F',
          `id=${p.threadId}`,
        ]);
      }
      console.log(JSON.stringify({ resolved: [...new Set(plan.map((p) => p.id))] }));
      return;
    }
    case 'comment': {
      const body = readFileSync(0, 'utf8');
      gh(['pr', 'comment', String(pr), '--body-file', '-'], body);
      console.log(JSON.stringify({ commented: true }));
      return;
    }
    default:
      console.error(
        'usage: node tools/pr-review.mjs <info|post|threads|resolve|comment> --pr <n> ...',
      );
      process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`pr-review: ${err.message}`);
    process.exitCode = 1;
  }
}
