import { describe, expect, it } from 'vitest';
import { GraphQLRequestError, parseRetryAfter } from './errors';

describe('GraphQLRequestError', () => {
  it("exposes the first error's code, if any", () => {
    const readOnly = { message: 'x', extensions: { code: 'READ_ONLY' } };
    expect(new GraphQLRequestError(200, [readOnly, { message: 'y' }]).code).toBe('READ_ONLY');
    expect(new GraphQLRequestError(200, [{ message: 'x', extensions: { code: 7 } }]).code).toBe(
      undefined,
    );
    expect(new GraphQLRequestError(200, [{ message: 'x' }]).code).toBeUndefined();
    expect(new GraphQLRequestError(502).code).toBeUndefined();
  });

  it('keeps the Retry-After seconds and the cause', () => {
    const cause = new TypeError('fetch failed');
    const error = new GraphQLRequestError(502, [{ message: 'API unavailable' }], {
      retryAfter: 3,
      cause,
    });
    expect(error).toMatchObject({ status: 502, message: 'API unavailable', retryAfter: 3, cause });
    expect(new GraphQLRequestError(400)).not.toHaveProperty('cause');
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');

  it('reads delta-seconds and HTTP dates as whole seconds, at least 1', () => {
    expect(parseRetryAfter('30', now)).toBe(30);
    expect(parseRetryAfter(' 7 ', now)).toBe(7);
    expect(parseRetryAfter('0', now)).toBe(1);
    expect(parseRetryAfter('Thu, 01 Oct 2026 12:00:42 GMT', now)).toBe(42);
    expect(parseRetryAfter('Thu, 01 Oct 2026 11:00:00 GMT', now)).toBe(1); // already past
  });

  it('ignores a missing or unreadable header', () => {
    for (const header of [null, '', 'soon', '-5', '1.5', 'Thu, 01 Oct 2026 12:00:42'])
      expect(parseRetryAfter(header, now)).toBeUndefined();
  });
});
