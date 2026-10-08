import { RATE_LIMITED, READ_ONLY } from '@acme/validators/error-codes';
import { CommentInput, NoteInput } from '@acme/validators/notes';
import { describe, expect, it } from 'vitest';
import { fieldErrors, writeErrorMessage } from './forms';
import { GraphQLRequestError } from './graphql/errors';

describe('fieldErrors', () => {
  it("maps Zod issues to the form's fields, the first message per field", () => {
    const result = NoteInput.safeParse({ title: ' ', body: 'x'.repeat(5001) });
    expect(fieldErrors(result.error?.issues ?? [], ['title', 'body'])).toEqual({
      title: 'Title is required',
      body: 'Must be at most 5000 characters',
    });
    const issues = [
      { path: ['title'], message: 'first' },
      { path: ['title'], message: 'second' },
    ];
    expect(fieldErrors(issues, ['title'])).toEqual({ title: 'first' });
  });

  it("maps the API's ValidationError paths below the argument", () => {
    const apiErrors = [
      { path: ['input', 'title'], message: 'Must be at most 120 characters' },
      { path: ['input', 'title'], message: 'second message for the same field' },
      { path: ['input', 'body'], message: 'Body is required' },
    ];
    expect(fieldErrors(apiErrors, ['title', 'body'], { argument: 'input' })).toEqual({
      title: 'Must be at most 120 characters',
      body: 'Body is required',
    });
  });

  it('puts what belongs to no field (a hidden id, a nested path) under `form`', () => {
    const result = CommentInput.safeParse({ noteId: 'nope', body: 'hi' });
    expect(fieldErrors(result.error?.issues ?? [], ['authorName', 'body'])).toEqual({
      form: 'Invalid note id',
    });
    const nested = [{ path: ['input', 'body', 0], message: 'odd' }];
    expect(fieldErrors(nested, ['body'], { argument: 'input' })).toEqual({ form: 'odd' });
  });
});

/** A write the API or the BFF refused with top-level errors. */
const refused = (status: number, code?: string, retryAfter?: number) =>
  new GraphQLRequestError(status, [{ message: 'refused', extensions: { code } }], { retryAfter });

describe('writeErrorMessage', () => {
  it('says when the API is read-only', () => {
    expect(writeErrorMessage(refused(200, READ_ONLY))).toBe(
      'The board is read-only right now: nothing was saved.',
    );
  });

  it("says how long to wait after too many writes, in the BFF's words", () => {
    expect(writeErrorMessage(refused(429, RATE_LIMITED, 12))).toBe(
      'Too many writes: try again in 12 s.',
    );
    // a 429 without the code or the header (a proxy's, not the BFF's): no made-up wait
    expect(writeErrorMessage(new GraphQLRequestError(429))).toBe(
      'Too many writes: try again in a moment.',
    );
  });

  it('falls back to a generic message (network failures, masked errors)', () => {
    for (const error of [new TypeError('fetch failed'), refused(200), new GraphQLRequestError(502)])
      expect(writeErrorMessage(error)).toBe('Could not save. Check your connection and try again.');
  });
});
