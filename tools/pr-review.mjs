#!/usr/bin/env node
// Deterministic GitHub plumbing for the review loop (.claude/workflows/review-loop-run.js).
// Agents call these subcommands instead of improvising `gh api` requests.
//
//   node tools/pr-review.mjs info    --pr <n>                      PR metadata, description and the
//        discussion by the PR author and your `gh` user (JSON); other people's comments are left out
//   node tools/pr-review.mjs head    --pr <n>                      { sha, branch, crossRepository }
//        → fails for fork PRs and for branch names that are not plain ref names
//   node tools/pr-review.mjs post    --pr <n> --round <r>   < findings.json
//        findings: [{ id?, path, line?, severity, title, body, suggestion? }]
//        → one PR review (event COMMENT) with inline comments on diff lines; findings that
//          can't be anchored to a changed line (file-level ones, files the PR does not change)
//          go into the review body. Prints { posted: [ids], inline }.
//   node tools/pr-review.mjs threads --pr <n> [--all] [--brief]    review-loop findings (JSON)
//        → [{ id, title, path, line, resolved, wontfix, body, ... }]: the review threads YOU
//          started, plus the findings you posted in a review body (threadId null);
//          --brief: { count, threads } without bodies (what the workflow relays)
//   node tools/pr-review.mjs resolve --pr <n> --commit <sha>  < resolutions.json
//        resolutions: [{ id, status: "fixed" | "wontfix", note }]  (id = the rl-… review-loop id)
//        → replies on every open thread with that id and resolves it; body findings (no thread)
//          get one PR comment that records their resolution. Fails, before touching anything,
//          on an id that matches no review-loop finding.
//   node tools/pr-review.mjs comment --pr <n>                 < markdown   plain PR comment
//
// Every finding ends with a hidden marker `<!-- review-loop:id=<id> -->` (a body finding also
// with `<!-- review-loop:at=… -->`, its path and line) so later rounds and runs can find, dedupe
// and resolve their own findings. Posting uses your `gh` login, and only what that login wrote
// counts: anyone can comment on a PR, and finding bodies are handed to an agent that edits,
// commits and pushes. For the same reason `info` passes on only what the PR author and your
// login wrote. `--pr` must be a number, so every command targets a pull request in the current
// repository.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER = 'review-loop:id=';
const AT_MARKER = 'review-loop:at=';
const RESOLVED_MARKER = 'review-loop:resolved=';
/** Starts every finding section of a review body (`---` alone could also be in a finding's text). */
const SECTION = '\n\n---\n<!-- review-loop:finding -->\n';
const WONTFIX_REPLY = "**Won't fix.**";
const fixedReply = (commit) => `**Addressed in ${String(commit).slice(0, 7)}.**`;

/** Stable id for a finding: same file + same title → same id across rounds. */
export function findingId(finding) {
  const key = `${finding.path ?? ''}::${String(finding.title ?? '')
    .trim()
    .toLowerCase()}`;
  return `rl-${createHash('sha256').update(key).digest('hex').slice(0, 8)}`;
}

/**
 * Pure: a unified diff of a PR's changed files, built from the per-file patches of the
 * `pulls/{n}/files` API. Unlike `gh pr diff`, that API also works for PRs whose whole diff is too
 * large for GitHub to render (HTTP 406). Files without a patch (binary or huge) get no lines.
 */
export function diffFromFiles(files) {
  return files
    .filter((f) => f.status !== 'removed' && typeof f.patch === 'string')
    .map((f) => `diff --git a/${f.filename} b/${f.filename}\n+++ b/${f.filename}\n${f.patch}`)
    .join('\n');
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

/**
 * Finding text with its review-loop markers made inert: they are hidden HTML comments, so the
 * change is invisible, and text that quotes a marker cannot pose as a finding or a section.
 */
const inert = (text) =>
  String(text ?? '').replaceAll('<!-- review-loop:', '<!-- (quoted) review-loop:');

/**
 * A finding as markdown. `located`: for the review body, where a finding has no thread to show its
 * file and line, so they are written out (and in a marker, for `bodyFindings`).
 */
export function commentBody(f, round, { located = false } = {}) {
  const where = located ? `\`${f.path ?? ''}${f.line ? `:${f.line}` : ''}\`` : '';
  const at = JSON.stringify({ path: f.path ?? null, line: f.line ?? null });
  return [
    `${SEVERITY_ICON[f.severity] ?? '•'} **${f.severity ?? 'issue'}: ${f.title}**`,
    '',
    inert(f.body),
    f.suggestion ? `\n**Suggested fix:** ${inert(f.suggestion)}` : '',
    where ? `\n${where}` : '',
    '',
    `<sub>review-loop round ${round} · \`${f.id}\`</sub>`,
    located ? `<!-- ${AT_MARKER}${encodeURIComponent(at)} -->` : undefined,
    `<!-- ${MARKER}${f.id} -->`,
  ]
    .filter((x) => x !== undefined)
    .join('\n')
    .trim();
}

/**
 * Pure: the findings `buildReview` put in a review body, each { id, path, line, title, body }.
 * Only sections that end with both markers count (text quoted inside a finding does not).
 */
export function bodyFindings(reviewBody) {
  const out = [];
  for (const raw of String(reviewBody ?? '')
    .split(SECTION)
    .slice(1)) {
    const section = raw.trim();
    const m = section.match(
      /<!-- review-loop:at=(\S+) -->\n<!-- review-loop:id=(rl-[0-9a-f]+) -->$/,
    );
    if (!m) continue;
    let at;
    try {
      at = JSON.parse(decodeURIComponent(m[1]));
    } catch {
      continue;
    }
    out.push({
      id: m[2],
      path: typeof at?.path === 'string' ? at.path : null,
      line: Number.isInteger(at?.line) ? at.line : null,
      title: titleFromBody(section),
      body: section,
    });
  }
  return out;
}

/**
 * Pure: the PR comment that records the resolution of findings in a review body, which have no
 * thread to reply in or resolve. entries: [{ id, status: "fixed" | "wontfix", note? }].
 */
export function resolutionComment(entries, commit) {
  const state = Object.fromEntries(entries.map((e) => [e.id, e.status]));
  return [
    '**Review loop:** findings from a review body (they have no thread to resolve)',
    '',
    ...entries.map((e) =>
      `- \`${e.id}\` ${e.status === 'wontfix' ? WONTFIX_REPLY : fixedReply(commit)} ${e.note ?? ''}`.trim(),
    ),
    '',
    `<!-- ${RESOLVED_MARKER}${encodeURIComponent(JSON.stringify(state))} -->`,
  ].join('\n');
}

/** The { id: status } a `resolutionComment` records (its marker must be the last line). */
export function resolvedIn(body) {
  const m = String(body ?? '').match(/<!-- review-loop:resolved=(\S+) -->\s*$/);
  if (!m) return undefined;
  try {
    const state = JSON.parse(decodeURIComponent(m[1]));
    return state && typeof state === 'object' && !Array.isArray(state) ? state : undefined;
  } catch {
    return undefined;
  }
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
 * A branch name that is safe to paste into `git push origin HEAD:refs/heads/<name>`: plain
 * ref-name characters only, and none of git's forbidden shapes (`..`, `//`, a leading `-`,
 * `/` or `.`, a component starting with `.`, a trailing `/`, `.` or `.lock`).
 */
export function isSafeBranch(name) {
  const n = String(name ?? '');
  return (
    /^[A-Za-z0-9._/-]+$/.test(n) &&
    !/^[-/.]/.test(n) &&
    !/[/.]$/.test(n) &&
    !n.endsWith('.lock') &&
    !n.includes('..') &&
    !n.includes('//') &&
    !n.includes('/.')
  );
}

/**
 * Pure: the head the review loop works on, from `gh pr view --json` metadata. Refuses fork PRs:
 * for them `headRefName` names the FORK's branch (pushing it to origin would write a base-repo
 * branch, even main), and the loop would run a stranger's code with this checkout's environment.
 */
export function headOf(meta) {
  if (meta?.isCrossRepository !== false) {
    const fork = meta?.headRepositoryOwner?.login
      ? ` (${meta.headRepositoryOwner.login}/${meta.headRepository?.name ?? '?'})`
      : '';
    throw new Error(
      `PR #${meta?.number} comes from ${meta?.isCrossRepository ? `a fork${fork}` : 'an unknown repository'}: the review loop pushes fixes and runs the PR's code, so it only runs on branches of this repository`,
    );
  }
  if (!/^[0-9a-f]{40}$/.test(meta.headRefOid ?? ''))
    throw new Error(`PR #${meta.number} has no head commit`);
  if (!isSafeBranch(meta.headRefName))
    throw new Error(
      `PR #${meta.number}'s head branch "${meta.headRefName}" is not a plain branch name (letters, digits, . _ / -)`,
    );
  return { sha: meta.headRefOid, branch: meta.headRefName, crossRepository: false };
}

/**
 * Pure: PR metadata, description and discussion for the loop's agents, keeping only comments and
 * reviews by the PR author and the viewer (`gh` user). Anyone can comment on a PR; those comments
 * must not reach agents that run commands and push.
 */
export function trustedInfo(pr, viewer) {
  const { comments = [], reviews = [], author, ...meta } = pr ?? {};
  const trusted = new Set([author?.login, viewer].filter(Boolean));
  const isTrusted = (item) => trusted.has(item?.author?.login);
  const texts = (items) =>
    items
      .filter((i) => isTrusted(i) && String(i.body ?? '').trim())
      .map((i) => ({
        author: i.author.login,
        ...(i.state ? { state: i.state } : {}),
        body: i.body,
      }));
  return {
    ...meta,
    author: author?.login,
    comments: texts(comments),
    reviews: texts(reviews),
    omittedFromOthers: [...comments, ...reviews].filter((i) => !isTrusted(i)).length,
  };
}

/**
 * A thread's comments, oldest first. THREADS_QUERY fetches the first comment (the finding, with
 * its marker) and the latest replies separately, so a long thread never hides either.
 */
function threadComments(t) {
  if (t.comments) return t.comments.nodes ?? [];
  const first = t.first?.nodes ?? [];
  const latest = (t.latest?.nodes ?? []).filter((c) => c.databaseId !== first[0]?.databaseId);
  return [...first, ...latest];
}

/**
 * Pure: the viewer's findings in review BODIES (see bodyFindings), as thread-like entries with
 * `threadId: null`. A finding is open from the review that posted it until a later resolution
 * comment by the viewer (see resolutionComment); posted again after that, it is open again.
 */
function bodyThreads(pr, viewer) {
  const events = [];
  for (const r of pr?.reviews?.nodes ?? [])
    if (r?.author?.login === viewer)
      for (const f of bodyFindings(r.body)) events.push({ at: r.createdAt ?? '', finding: f });
  for (const c of pr?.comments?.nodes ?? []) {
    if (c?.author?.login !== viewer) continue;
    for (const [id, status] of Object.entries(resolvedIn(c.body) ?? {}))
      events.push({ at: c.createdAt ?? '', id, status });
  }
  const byId = new Map();
  for (const e of events.toSorted((a, b) => String(a.at).localeCompare(String(b.at)))) {
    if (e.finding) byId.set(e.finding.id, { ...e.finding, resolved: false, wontfix: false });
    else if (byId.has(e.id) && (e.status === 'fixed' || e.status === 'wontfix'))
      Object.assign(byId.get(e.id), { resolved: true, wontfix: e.status === 'wontfix' });
  }
  return [...byId.values()].map((f) => ({
    id: f.id,
    threadId: null,
    commentId: null,
    resolved: f.resolved,
    wontfix: f.wontfix,
    path: f.path,
    line: f.line,
    title: f.title,
    body: f.body,
  }));
}

/**
 * Pure: the review-loop findings in a THREADS_QUERY response (`data`): threads whose first comment
 * was written by the viewer (the `gh` user running the loop) and carries a review-loop marker,
 * then the viewer's findings in review bodies. `wontfix` = the viewer's latest reply is a won't-fix.
 */
export function parseThreads(data, { all = false } = {}) {
  const viewer = data?.viewer?.login;
  const pr = data?.repository?.pullRequest;
  const nodes = pr?.reviewThreads?.nodes ?? [];
  const out = [];
  if (!viewer) return out;
  for (const t of nodes) {
    const comments = threadComments(t);
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
  for (const t of bodyThreads(pr, viewer)) if (all || !t.resolved) out.push(t);
  return out;
}

/** Pure: the reply + resolve for EVERY unresolved thread carrying each resolution's id. */
export function planResolutions(resolutions, openThreads, commit) {
  const plan = [];
  for (const r of resolutions) {
    if (r.status !== 'fixed' && r.status !== 'wontfix') continue;
    const verb = r.status === 'wontfix' ? WONTFIX_REPLY : fixedReply(commit);
    for (const t of openThreads) {
      if (t.id !== r.id || t.resolved || !t.threadId) continue;
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

/** Pure: the fixed/wontfix resolutions of open body findings (no thread), for resolutionComment. */
export function bodyResolutions(resolutions, list) {
  const open = new Set(list.filter((t) => !t.threadId && !t.resolved).map((t) => t.id));
  const seen = new Set();
  return resolutions.filter(
    (r) =>
      (r.status === 'fixed' || r.status === 'wontfix') &&
      open.has(r.id) &&
      !seen.has(r.id) &&
      seen.add(r.id),
  );
}

/** Pure: `threads --brief` output: no bodies, plus a count so a relayed copy can be checked. */
export function briefThreads(list) {
  return {
    count: list.length,
    threads: list.map(({ id, title, path, line, resolved, wontfix }) => ({
      id,
      title: title ?? null,
      path: path ?? null,
      line: line ?? null,
      resolved,
      wontfix,
    })),
  };
}

/** Pure: ids of fixed/wontfix resolutions that match no review-loop thread (a typo, or a PRRT_ node id). */
export function unknownIds(resolutions, known) {
  const ids = new Set(known.map((t) => t.id));
  return resolutions
    .filter((r) => (r.status === 'fixed' || r.status === 'wontfix') && !ids.has(r.id))
    .map((r) => String(r.id));
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
  ].join('\n');
  const sections = unanchored.map((f) => `${SECTION}${commentBody(f, round, { located: true })}`);
  return {
    commit_id: commitId,
    event: 'COMMENT',
    body: body + sections.join(''),
    comments: inline,
  };
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

const PR_META =
  'number,url,title,state,author,baseRefName,headRefName,headRefOid,isCrossRepository,headRepositoryOwner,headRepository,maintainerCanModify';

function prInfo(pr, extra = '') {
  return JSON.parse(gh(['pr', 'view', String(pr), '--json', `${PR_META}${extra}`]));
}

function viewerLogin() {
  return gh(['api', 'user', '--jq', '.login']).trim();
}

// Oldest first, 100 per page. Each thread: its first comment (the finding) and its latest replies.
// Plus the latest reviews and PR comments (body findings and their resolutions), read from the
// first page.
const THREADS_QUERY = `query($owner:String!,$name:String!,$pr:Int!,$after:String){viewer{login} repository(owner:$owner,name:$name){pullRequest(number:$pr){reviews(last:100){nodes{body createdAt author{login}}} comments(last:100){nodes{body createdAt author{login}}} reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved path line first:comments(first:1){nodes{databaseId body author{login}}} latest:comments(last:50){nodes{databaseId body author{login}}}}}}}}`;

function threads(pr, all = false) {
  const [owner, name] = repoSlug().split('/');
  const nodes = [];
  let viewer;
  let first;
  let after;
  for (;;) {
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
        ...(after ? ['-f', `after=${after}`] : []),
      ]),
    );
    const page = res.data?.repository?.pullRequest?.reviewThreads;
    if (!page) throw new Error(`could not read the review threads of PR #${pr}`);
    viewer = res.data.viewer;
    first ??= res.data.repository.pullRequest;
    nodes.push(...(page.nodes ?? []));
    if (!page.pageInfo?.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  const { reviews, comments } = first;
  return parseThreads(
    { viewer, repository: { pullRequest: { reviews, comments, reviewThreads: { nodes } } } },
    { all },
  );
}

/** The PR's diff, from its per-file patches (see diffFromFiles). */
function prDiff(pr) {
  const out = gh([
    'api',
    `repos/${repoSlug()}/pulls/${pr}/files`,
    '--paginate',
    '--jq',
    '.[] | {filename, status, patch}',
  ]);
  return diffFromFiles(
    out
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l)),
  );
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
  const known = ['info', 'head', 'post', 'threads', 'resolve', 'comment'];
  const pr = known.includes(cmd) ? prNumber(arg(argv, 'pr')) : undefined;
  switch (cmd) {
    case 'info':
      console.log(
        JSON.stringify(trustedInfo(prInfo(pr, ',body,comments,reviews'), viewerLogin()), null, 2),
      );
      return;
    case 'head': {
      const head = headOf(prInfo(pr));
      // git's own rules on top of isSafeBranch (throws on a name git would not accept)
      execFileSync('git', ['check-ref-format', '--branch', head.branch], { stdio: 'ignore' });
      console.log(JSON.stringify(head));
      return;
    }
    case 'post': {
      const round = Number(arg(argv, 'round') ?? 1);
      const findings = readStdinJson();
      const info = prInfo(pr);
      const review = buildReview({ findings, diff: prDiff(pr), round, commitId: info.headRefOid });
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
    case 'threads': {
      const list = threads(pr, argv.includes('--all'));
      console.log(JSON.stringify(argv.includes('--brief') ? briefThreads(list) : list, null, 2));
      return;
    }
    case 'resolve': {
      const commit = arg(argv, 'commit');
      if (!/^[0-9a-f]{7,40}$/i.test(commit ?? ''))
        throw new Error(
          '--commit <sha> is required (the pushed commit that addresses the findings)',
        );
      const resolutions = readStdinJson();
      if (!Array.isArray(resolutions)) throw new Error('resolve: stdin must be a JSON array');
      const all = threads(pr, true);
      const unknown = unknownIds(resolutions, all);
      if (unknown.length)
        throw new Error(
          `no review-loop finding has the id ${unknown.join(', ')}: use the "id" (rl-…) that \`threads\` prints, not "threadId"`,
        );
      const plan = planResolutions(resolutions, all, commit);
      const inBody = bodyResolutions(resolutions, all);
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
      if (inBody.length)
        gh(['pr', 'comment', String(pr), '--body-file', '-'], resolutionComment(inBody, commit));
      console.log(
        JSON.stringify({ resolved: [...new Set([...plan, ...inBody].map((p) => p.id))] }),
      );
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
        'usage: node tools/pr-review.mjs <info|head|post|threads|resolve|comment> --pr <n> ...',
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
