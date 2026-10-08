import { describe, expect, it } from 'vitest';
import { authorName, commentCountLabel, excerpt, formatTimestamp } from './format';

describe('excerpt', () => {
  it('keeps a short body, on one line', () => {
    expect(excerpt('  Hello\n\n  world\t!  ')).toBe('Hello world !');
  });

  it('cuts a long body at a word and marks it', () => {
    const body = `${'word '.repeat(50)}end`;
    const result = excerpt(body, 40);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).toMatch(/^word( word)+…$/);
  });

  it('cuts a long unbroken word instead of dropping it', () => {
    expect(excerpt('x'.repeat(500), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('never cuts an emoji in half: the server would send U+FFFD, a hydration mismatch', () => {
    // no space after position 80: the long-word path keeps the raw cut
    for (const body of ['🎉'.repeat(100), `Party ${'🎉'.repeat(100)}`]) {
      const result = excerpt(body);
      // what React's SSR stream does to the text (TextEncoder turns a lone surrogate into U+FFFD)
      expect(new TextDecoder().decode(new TextEncoder().encode(result))).toBe(result);
      expect(result).toMatch(/🎉…$/u);
    }
  });

  it('returns text, never markup', () => {
    expect(excerpt('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('formatTimestamp', () => {
  it('formats an API timestamp the same way on the server and in the browser (UTC)', () => {
    expect(formatTimestamp('2026-01-01T09:01:30.123Z')).toBe('2026-01-01 09:01 UTC');
  });

  it('leaves an unreadable value as it is', () => {
    expect(formatTimestamp('yesterday')).toBe('yesterday');
  });
});

describe('authorName', () => {
  it('shows "Anonymous" for a missing or blank name', () => {
    expect(authorName('Ada')).toBe('Ada');
    for (const name of [null, undefined, '', '   ']) expect(authorName(name)).toBe('Anonymous');
  });
});

describe('commentCountLabel', () => {
  it('pluralizes', () => {
    expect([0, 1, 2].map(commentCountLabel)).toEqual(['0 comments', '1 comment', '2 comments']);
  });
});
