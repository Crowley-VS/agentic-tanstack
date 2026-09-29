import { describe, expect, it } from 'vitest';
import { anchorLine, buildReview, commentableLines, findingId, MARKER } from '../pr-review.mjs';

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
