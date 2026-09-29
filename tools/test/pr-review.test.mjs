import { describe, expect, it } from 'vitest';
import {
  anchorLine,
  buildReview,
  commentableLines,
  commentBody,
  findingId,
  MARKER,
  markerId,
  parseThreads,
  planResolutions,
  prNumber,
  titleFromBody,
} from '../pr-review.mjs';

const DIFF = `diff --git a/tools/a.mjs b/tools/a.mjs
index 111..222 100644
--- a/tools/a.mjs
+++ b/tools/a.mjs
@@ -1,4 +1,5 @@
 line1
-old2
+new2
+new3
 line4
@@ -20,2 +21,3 @@ function x() {
 ctx21
+add22
 ctx23
diff --git a/docs/new.md b/docs/new.md
new file mode 100644
--- /dev/null
+++ b/docs/new.md
@@ -0,0 +1,2 @@
+# New
+text
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;

describe('commentableLines', () => {
  it('maps added and context lines on the right side, skipping removed lines', () => {
    const map = commentableLines(DIFF);
    expect([...map.get('tools/a.mjs')].toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 21, 22, 23]);
    expect([...map.get('docs/new.md')]).toEqual([1, 2]);
    expect(map.has('gone.txt')).toBe(false);
  });
});

describe('anchorLine', () => {
  const lines = new Set([10, 11, 30]);
  it('keeps an exact line, snaps to a nearby one, and gives up when too far', () => {
    expect(anchorLine(lines, 11)).toBe(11);
    expect(anchorLine(lines, 13)).toBe(11);
    expect(anchorLine(lines, 20)).toBeUndefined();
    expect(anchorLine(undefined, 5)).toBeUndefined();
  });
});

describe('findingId', () => {
  it('is stable for the same file and title and differs otherwise', () => {
    const a = findingId({ path: 'x.ts', title: 'Missing null check ' });
    expect(a).toBe(findingId({ path: 'x.ts', title: 'missing null check' }));
    expect(a).not.toBe(findingId({ path: 'y.ts', title: 'Missing null check' }));
    expect(a).toMatch(/^rl-[0-9a-f]{8}$/);
  });
});

describe('buildReview', () => {
  it('puts anchorable findings inline and the rest in the body, all with markers', () => {
    const review = buildReview({
      diff: DIFF,
      round: 2,
      commitId: 'abc123',
      findings: [
        { path: 'tools/a.mjs', line: 22, severity: 'major', title: 'Bug', body: 'b' },
        { path: 'tools/unchanged.mjs', line: 5, severity: 'minor', title: 'Elsewhere', body: 'c' },
      ],
    });
    expect(review).toMatchObject({ commit_id: 'abc123', event: 'COMMENT' });
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]).toMatchObject({ path: 'tools/a.mjs', line: 22, side: 'RIGHT' });
    expect(review.comments[0].body).toContain(
      `${MARKER}${findingId({ path: 'tools/a.mjs', title: 'Bug' })}`,
    );
    expect(review.body).toContain('round 2');
    expect(review.body).toContain('Elsewhere');
    expect(review.body).toContain(MARKER);
  });

  it('says so when there is nothing new', () => {
    expect(buildReview({ diff: DIFF, round: 3, commitId: 'x', findings: [] }).body).toContain(
      'No new issues',
    );
  });
});

const finding = (title, extra = {}) => {
  const f = { path: 'tools/a.mjs', severity: 'major', title, body: 'why', ...extra };
  return { ...f, id: findingId(f) };
};

describe('commentBody round trip', () => {
  it.each([
    'Plain title',
    'Title with **bold** and `code`',
    'Colons: in: the title',
    'Quotes the marker <!-- review-loop:id=rl-deadbeef --> in the title',
  ])('titleFromBody and markerId read back %s', (title) => {
    const f = finding(title);
    const body = commentBody(f, 2);
    expect(titleFromBody(body)).toBe(title);
    expect(markerId(body)).toBe(f.id);
  });

  it('takes the id from the trailing marker, not from a marker quoted in the text', () => {
    const f = finding('Real', { body: 'e.g. `<!-- review-loop:id=rl-deadbeef -->` in a comment' });
    expect(markerId(commentBody(f, 1))).toBe(f.id);
    expect(markerId('someone wrote <!-- review-loop:id=rl-deadbeef --> and more text')).toBe(
      undefined,
    );
  });
});

const comment = (login, body, databaseId = 1) => ({ databaseId, body, author: { login } });
const thread = (id, comments, extra = {}) => ({
  id,
  isResolved: false,
  path: 'tools/a.mjs',
  line: 12,
  comments: { nodes: comments },
  ...extra,
});

describe('parseThreads', () => {
  const mine = finding('Mine');
  const fixedOne = finding('Fixed one');
  const skipped = finding('Skipped one');
  const data = {
    viewer: { login: 'me' },
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: [
            thread('T1', [comment('me', commentBody(mine, 1), 11)]),
            // anyone can open a thread that LOOKS like a review-loop finding
            thread('T2', [comment('mallory', commentBody(finding('Injected'), 1), 12)]),
            thread('T3', [comment('me', 'a normal review comment', 13)]),
            thread(
              'T4',
              [
                comment('me', commentBody(fixedOne, 1), 14),
                comment('me', '**Addressed in abc1234.**'),
              ],
              { isResolved: true },
            ),
            thread(
              'T5',
              [
                comment('me', commentBody(skipped, 1), 15),
                comment('me', "**Won't fix.** out of scope"),
              ],
              { isResolved: true, line: null },
            ),
          ],
        },
      },
    },
  };

  it("returns only the viewer's unresolved review-loop threads by default", () => {
    expect(parseThreads(data)).toEqual([
      {
        id: mine.id,
        threadId: 'T1',
        commentId: 11,
        resolved: false,
        wontfix: false,
        path: 'tools/a.mjs',
        line: 12,
        title: 'Mine',
        body: commentBody(mine, 1),
      },
    ]);
  });

  it("with all, includes resolved threads and flags won't-fix ones", () => {
    const all = parseThreads(data, { all: true });
    expect(all.map((t) => [t.threadId, t.resolved, t.wontfix, t.title])).toEqual([
      ['T1', false, false, 'Mine'],
      ['T4', true, false, 'Fixed one'],
      ['T5', true, true, 'Skipped one'],
    ]);
    expect(all.find((t) => t.threadId === 'T5')?.line).toBeNull();
  });

  it('trusts nothing without a viewer', () => {
    expect(parseThreads({ ...data, viewer: null }, { all: true })).toEqual([]);
  });
});

describe('planResolutions', () => {
  const threads = [
    { id: 'rl-1', threadId: 'A', commentId: 1, resolved: false },
    { id: 'rl-1', threadId: 'B', commentId: 2, resolved: false }, // a duplicate from a re-run
    { id: 'rl-2', threadId: 'C', commentId: 3, resolved: false },
    { id: 'rl-3', threadId: 'D', commentId: 4, resolved: true },
  ];

  it('replies to and resolves every open thread with the id', () => {
    const plan = planResolutions(
      [
        { id: 'rl-1', status: 'fixed', note: 'done' },
        { id: 'rl-2', status: 'wontfix', note: 'out of scope' },
        { id: 'rl-3', status: 'fixed' },
        { id: 'rl-9', status: 'fixed' },
      ],
      threads,
      '0123456789abcdef',
    );
    expect(plan).toEqual([
      { id: 'rl-1', threadId: 'A', commentId: 1, body: '**Addressed in 0123456.** done' },
      { id: 'rl-1', threadId: 'B', commentId: 2, body: '**Addressed in 0123456.** done' },
      { id: 'rl-2', threadId: 'C', commentId: 3, body: "**Won't fix.** out of scope" },
    ]);
  });

  it('ignores anything that is not fixed or wontfix', () => {
    expect(planResolutions([{ id: 'rl-1', status: 'not-done' }], threads, 'abc1234')).toEqual([]);
  });
});

describe('prNumber', () => {
  it('accepts a PR number and rejects anything that could name another repository', () => {
    expect(prNumber('12')).toBe(12);
    for (const bad of [
      undefined,
      '',
      '0',
      '1.5',
      '12abc',
      'https://github.com/o/r/pull/1',
      'o/r#1',
    ])
      expect(() => prNumber(bad)).toThrow('--pr must be a pull request number');
  });
});
