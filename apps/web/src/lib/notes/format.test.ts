import { describe, expect, it } from 'vitest';
import { authorName, commentCountLabel, excerpt, formatTimestamp, sourceHref } from './format';

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

describe('sourceHref', () => {
  it('links an http or https URL as it is', () => {
    for (const url of ['https://example.com/a?b=1#c', 'http://localhost:3000/', 'HTTPS://EX.COM'])
      expect(sourceHref(url)).toBe(url);
  });

  it('never links a missing URL or another scheme', () => {
    for (const url of [
      null,
      undefined,
      '',
      'javascript:alert(1)',
      ' JavaScript:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'ftp://example.com/',
      '/relative/path',
      'not a url',
    ])
      expect(sourceHref(url), String(url)).toBeUndefined();
  });
});

describe('commentCountLabel', () => {
  it('pluralizes', () => {
    expect([0, 1, 2].map(commentCountLabel)).toEqual(['0 comments', '1 comment', '2 comments']);
  });
});
