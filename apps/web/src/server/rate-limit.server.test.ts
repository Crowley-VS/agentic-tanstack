import { RATE_LIMITED } from '@acme/validators/error-codes';
import { describe, expect, it } from 'vitest';
import {
  clientKey,
  createWriteLimiter,
  rateLimited,
  writeLimiter,
  writesIn,
} from './rate-limit.server';

const body = (params: unknown) => JSON.stringify(params);
const writes = (query: string) => writesIn(body({ query }));

describe('writesIn', () => {
  it('counts mutations, and lets queries through', () => {
    expect(writes('mutation { createNote { __typename } }')).toBe(1);
    expect(writes('query Notes { notes { totalCount } }')).toBe(0);
    expect(writesIn(body({ query: '{ apiVersion }', variables: null, operationName: null }))).toBe(
      0,
    );
  });

  it('honours operationName in a document with several operations', () => {
    const query = 'query Read { apiVersion } mutation Write { createNote { __typename } }';
    expect(writesIn(body({ query, operationName: 'Read' }))).toBe(0);
    expect(writesIn(body({ query, operationName: 'Write' }))).toBe(1);
  });

  it('counts every root field of a mutation: aliases make one request write many times', () => {
    expect(writes('mutation { a: createNote { id } b: createNote { id } addComment { id } }')).toBe(
      3,
    );
    // through fragment spreads and inline fragments
    expect(
      writes(
        'mutation { ...F ... on Mutation { c: createNote { id } } } ' +
          'fragment F on Mutation { a: createNote { id } b: createNote { id } }',
      ),
    ).toBe(3);
  });

  it('counts fields the API merges (one response key) once, and ends on a fragment cycle', () => {
    expect(writes('mutation { createNote { id } createNote { __typename } }')).toBe(1);
    expect(writes('mutation { ...F ...F } fragment F on Mutation { a: createNote { id } }')).toBe(
      1,
    );
    expect(writes('mutation { ...F } fragment F on Mutation { a: createNote { id } ...F }')).toBe(
      1,
    );
  });

  it.each([
    ['invalid JSON', '{"query":'],
    ['JSON that is not an object', 'null'],
    ['a batch', body([{ query: '{ apiVersion }' }])],
    [
      'a persisted query (no query text)',
      body({ extensions: { persistedQuery: { sha256Hash: 'abc' } } }),
    ],
    ['a syntax error', body({ query: '{ apiVersion' })],
    ['several operations and no name', body({ query: 'query A { a } query B { b }' })],
    ['an unknown operation name', body({ query: 'query A { a }', operationName: 'B' })],
    ['an operation name that is not a string', body({ query: '{ a }', operationName: 1 })],
    ['a subscription', body({ query: 'subscription { a }' })],
  ])('counts a body it cannot be sure about as a write: %s', (_, text) => {
    expect(writesIn(text)).toBe(1);
  });
});

describe('clientKey', () => {
  it('is the IPv4 address itself', () => {
    expect(clientKey('203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey(undefined)).toBe('unknown');
  });

  it("is an IPv6 address's /64, however the address is written", () => {
    const key = '2001:db8:0:1::/64';
    expect(clientKey('2001:db8:0:1::1')).toBe(key);
    expect(clientKey('2001:0DB8:0000:0001:ffff:ffff:ffff:ffff')).toBe(key);
    expect(clientKey('2001:db8:0:1:abcd::')).toBe(key);
    expect(clientKey('2001:db8::1:0:0:1')).toBe('2001:db8:0:0::/64');
    expect(clientKey('::1')).toBe('0:0:0:0::/64');
  });
});

/** A clock the test moves by hand. */
function clock() {
  let time = 0;
  return { now: () => time, advance: (ms: number) => (time += ms) };
}

describe('createWriteLimiter', () => {
  it('allows `limit` writes per window, then says how long to wait', () => {
    const { now, advance } = clock();
    const limiter = createWriteLimiter({ limit: 2, windowMs: 60_000 }, { now });
    expect(limiter.hit('a')).toEqual({ ok: true });
    advance(10_000);
    expect(limiter.hit('a')).toEqual({ ok: true });
    expect(limiter.hit('a')).toEqual({ ok: false, retryAfterSeconds: 50 });
    expect(limiter.hit('b')).toEqual({ ok: true }); // per client
    advance(49_500);
    expect(limiter.hit('a')).toEqual({ ok: false, retryAfterSeconds: 1 });
    advance(500); // the window opened by the first write closes
    expect(limiter.hit('a')).toEqual({ ok: true });
  });

  it('counts a request with several writes as that many, and refuses it whole', () => {
    const limiter = createWriteLimiter({ limit: 3, windowMs: 60_000 }, { now: clock().now });
    expect(limiter.hit('a', 2)).toEqual({ ok: true });
    expect(limiter.hit('a', 2)).toMatchObject({ ok: false }); // 4 > 3, and nothing counted
    expect(limiter.hit('a')).toEqual({ ok: true });
    expect(limiter.hit('a')).toMatchObject({ ok: false });
    expect(limiter.hit('b', 4)).toMatchObject({ ok: false }); // more than the limit: never
  });

  it('forgets closed windows, and never holds more than maxClients', () => {
    const { now, advance } = clock();
    const limiter = createWriteLimiter({ limit: 1, windowMs: 1000 }, { now, maxClients: 3 });
    for (const client of ['a', 'b', 'c', 'd', 'e']) limiter.hit(client);
    expect(limiter.size).toBe(3);
    expect(limiter.hit('e')).toMatchObject({ ok: false }); // the newest are remembered
    expect(limiter.hit('a')).toEqual({ ok: true }); // the oldest were evicted
    advance(1000);
    limiter.hit('f');
    expect(limiter.size).toBe(1);
  });
});

describe('writeLimiter', () => {
  it('keeps one limiter per rule for the whole process', () => {
    const rule = { limit: 3, windowMs: 1000 };
    expect(writeLimiter(rule)).toBe(writeLimiter({ ...rule }));
    expect(writeLimiter({ limit: 4, windowMs: 1000 })).not.toBe(writeLimiter(rule));
  });
});

describe('rateLimited', () => {
  it('answers 429 in GraphQL shape, with Retry-After and the RATE_LIMITED code', async () => {
    const res = rateLimited(42);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
    expect(await res.json()).toEqual({
      errors: [
        {
          message: 'Too many writes: try again in 42 s.',
          extensions: { code: RATE_LIMITED, retryAfter: 42 },
        },
      ],
    });
  });
});
