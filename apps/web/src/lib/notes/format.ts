// Plain-text helpers for notes: what the board shows of a body, timestamps, comment authors.
// Everything renders as React text (escaped); nothing here returns HTML.

/** The start of a body as one line: whitespace collapsed, cut at a word, "…" when shortened. */
export function excerpt(body: string, max = 160): string {
  const text = body.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  // never end on the first half of a surrogate pair (an emoji): SSR would send U+FFFD in its
  // place, the browser the half, and hydration would find different text
  const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 2)) ? max - 2 : max - 1;
  const cut = text.slice(0, end);
  const space = cut.lastIndexOf(' ');
  // a long unbroken word (a URL) is cut mid-word rather than dropped
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * An API timestamp (ISO 8601, UTC) as "2026-01-01 09:01 UTC". Deterministic on purpose: the server
 * renders it and the browser hydrates the same text; a local time zone or locale would differ.
 */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** A comment's author: the name given, or "Anonymous". */
export const authorName = (name: string | null | undefined) => name?.trim() || 'Anonymous';

/** "1 comment", "3 comments". */
export const commentCountLabel = (count: number) => `${count} comment${count === 1 ? '' : 's'}`;
