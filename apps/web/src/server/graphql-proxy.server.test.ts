import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { RATE_LIMITED } from '@acme/validators/error-codes';
import { CLIENT_IP_HEADER, REQUEST_ID_HEADER, SECRET_HEADER } from '@acme/validators/internal-api';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { serverEnv } from '../env.server';
import { MAX_BODY_BYTES, proxyGraphql, readBodyText } from './graphql-proxy.server';
import { callInternalApi } from './internal-api.server';

const SECRET = 's'.repeat(32);
/** A request body that makes the stub API never answer. */
const HANG = '{"query":"{ hang }"}';
const QUERY = '{"query":"{ ok }"}';
const MUTATION = '{"query":"mutation { createNote { __typename } }"}';
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
let upstream: Server;
let port: number;
let received: { headers: IncomingHttpHeaders; body: string } | undefined;
/** What the stub API answers next. */
let reply: { status: number; headers: Record<string, string>; body: string };

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      received = { headers: req.headers, body };
      if (body === HANG) return;
      res.writeHead(reply.status, reply.headers);
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (address === null || typeof address === 'string') throw new Error('stub API has no port');
  port = address.port;
});
afterAll(() => {
  upstream.closeAllConnections();
  return new Promise<void>((resolve) => upstream.close(() => resolve()));
});
beforeEach(() => {
  received = undefined;
  reply = {
    status: 200,
    headers: { 'content-type': 'application/graphql-response+json' },
    body: JSON.stringify({ data: { ok: true } }),
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return () => vi.restoreAllMocks();
});

const env = (overrides: Record<string, string | undefined> = {}) =>
  serverEnv({
    API_HOST: '127.0.0.1',
    API_PORT: String(port),
    INTERNAL_API_SECRET: SECRET,
    ...overrides,
  });
function post(body: BodyInit, headers: Record<string, string> = {}, signal?: AbortSignal) {
  // `duplex` is required by Node for a streamed body, and missing from the DOM RequestInit type
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    signal,
    duplex: 'half',
  };
  return new Request('http://web.test/api/graphql', init);
}
/** A body streamed in chunks with no Content-Length, like a chunked upload. */
const stream = (size: number) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (let sent = 0; sent < size; sent += 1024) controller.enqueue(new Uint8Array(1024));
      controller.close();
    },
  });

describe('proxyGraphql', () => {
  it('forwards the JSON body with the shared secret and relays the answer', async () => {
    const res = await proxyGraphql(post(QUERY, { cookie: 'a=b' }), env());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/graphql-response+json');
    expect(await res.json()).toEqual({ data: { ok: true } });
    expect(received?.body).toBe(QUERY);
    expect(received?.headers[SECRET_HEADER]).toBe(SECRET);
    expect(received?.headers.cookie).toBeUndefined(); // browser headers are not forwarded
  });

  it("relays the API's status, but no header besides its content type", async () => {
    reply = {
      status: 401,
      headers: { 'set-cookie': 'x=1', 'x-powered-by': 'api', 'access-control-allow-origin': '*' },
      body: JSON.stringify({ errors: [{ message: 'Unauthorized' }] }),
    };
    const res = await proxyGraphql(post(QUERY), env());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ errors: [{ message: 'Unauthorized' }] });
    // the API sent no content type: the proxy says JSON; it adds only its request id
    expect([...res.headers.keys()].toSorted()).toEqual(['content-type', REQUEST_ID_HEADER]);
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  it("sends the client's IP and a request id, and answers with that id", async () => {
    const res = await proxyGraphql(post(QUERY), env(), { socketIp: '::ffff:198.51.100.7' });
    expect(received?.headers[CLIENT_IP_HEADER]).toBe('198.51.100.7');
    const id = received?.headers[REQUEST_ID_HEADER];
    expect(id).toMatch(UUID);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(id);
  });

  it('takes the IP from REAL_IP_HEADER, never from X-Forwarded-For', async () => {
    const socketIp = '10.0.0.1'; // the proxy in front: every client comes from it
    const headers = { 'x-real-ip': '203.0.113.5', 'x-forwarded-for': '192.0.2.1' };
    await proxyGraphql(post(QUERY, headers), env(), { socketIp });
    expect(received?.headers[CLIENT_IP_HEADER]).toBe('203.0.113.5');
    // no proxy in front: what the client claims is ignored
    await proxyGraphql(post(QUERY, headers), env({ REAL_IP_HEADER: '' }), { socketIp });
    expect(received?.headers[CLIENT_IP_HEADER]).toBe(socketIp);
  });

  it('keeps a sane request id from the browser or the edge, and replaces any other', async () => {
    const res = await proxyGraphql(post(QUERY, { [REQUEST_ID_HEADER]: 'edge-42' }), env());
    expect(received?.headers[REQUEST_ID_HEADER]).toBe('edge-42');
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe('edge-42');
    for (const id of ['x'.repeat(129), 'a b', 'id="x"']) {
      await proxyGraphql(post(QUERY, { [REQUEST_ID_HEADER]: id }), env());
      expect(received?.headers[REQUEST_ID_HEADER]).toMatch(UUID);
    }
  });

  it('refuses a body over 64 KB, declared or streamed, without calling the API', async () => {
    // the declared length alone decides: the body is never read
    const declared = post('{}', { 'content-length': String(MAX_BODY_BYTES + 1) });
    expect((await proxyGraphql(declared, env())).status).toBe(413);
    const big = 'a'.repeat(MAX_BODY_BYTES + 1);
    expect((await proxyGraphql(post(big), env())).status).toBe(413);
    expect((await proxyGraphql(post(stream(MAX_BODY_BYTES + 1024)), env())).status).toBe(413);
    expect(received).toBeUndefined();
  });

  it('accepts a streamed body up to the limit', async () => {
    expect(await readBodyText(post(stream(MAX_BODY_BYTES)), MAX_BODY_BYTES)).toHaveLength(
      MAX_BODY_BYTES,
    );
  });

  it('refuses anything but application/json, before reading the body', async () => {
    const res = await proxyGraphql(
      post('query=1', { 'content-type': 'text/plain', 'content-length': '999999' }),
      env(),
    );
    expect(res.status).toBe(415); // not 413: the content type is checked first
    expect(received).toBeUndefined();
  });

  it('answers 502 when the API is down, and logs it with the request id', async () => {
    const res = await proxyGraphql(post('{}'), env({ API_PORT: '1' }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ errors: [{ message: 'API unavailable' }] });
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^\[web\] \/api\/graphql: API unavailable \(request [\da-f-]{36}\)$/),
      expect.objectContaining({ message: 'fetch failed' }),
    );
  });

  it('answers 504 when the API does not answer in time, and logs it', async () => {
    const res = await proxyGraphql(post(HANG, { [REQUEST_ID_HEADER]: 'slow-1' }), env(), {
      timeoutMs: 50,
    });
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ errors: [{ message: 'API timed out' }] });
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      '[web] /api/graphql: API timed out (request slow-1)',
      expect.objectContaining({ name: 'TimeoutError' }),
    );
  });

  it('stops waiting for the API once the browser goes away, without logging an outage', async () => {
    const browser = new AbortController();
    const pending = proxyGraphql(post(HANG, {}, browser.signal), env());
    await vi.waitFor(() => expect(received?.body).toBe(HANG));
    browser.abort();
    expect((await pending).status).toBe(499); // nobody reads it
    expect(console.error).not.toHaveBeenCalled();
  });
});

/** Every test gets client IPs of its own: the process-wide rate limiter outlives a test. */
let lastIp = 0;
const freshIp = () => `198.51.100.${++lastIp}`;
const limited = (overrides: Record<string, string> = {}) =>
  env({ WRITE_RATE_LIMIT: '2/60s', ...overrides });
/** A mutation as the proxy in front passes it on: X-Real-IP names the client. */
const writeFrom = (ip: string) => post(MUTATION, { 'x-real-ip': ip });
/** A mutation whose client claims a new address in both headers it controls. */
const spoofed = (n: number) =>
  post(MUTATION, { 'x-forwarded-for': `192.0.2.${n}`, 'x-real-ip': `192.0.2.${n}` });

describe('the write rate limit', () => {
  it('answers the write after the limit with 429, Retry-After and RATE_LIMITED', async () => {
    const socketIp = freshIp();
    for (let i = 0; i < 2; i++)
      expect((await proxyGraphql(post(MUTATION), limited(), { socketIp })).status).toBe(200);
    received = undefined;
    const res = await proxyGraphql(post(MUTATION), limited(), { socketIp });
    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThanOrEqual(59);
    expect(await res.json()).toEqual({
      errors: [
        {
          message: `Too many writes: try again in ${retryAfter} s.`,
          extensions: { code: RATE_LIMITED, retryAfter },
        },
      ],
    });
    expect(received).toBeUndefined(); // the API never saw it
    // another client still writes
    expect((await proxyGraphql(post(MUTATION), limited(), { socketIp: freshIp() })).status).toBe(
      200,
    );
  });

  it('counts each root field of a mutation: two aliases use up the window', async () => {
    /** One mutation request that creates `n` notes through aliases. */
    const aliased = (n: number) => {
      const fields = Array.from({ length: n }, (_, i) => `a${i}: createNote { __typename }`);
      return post(JSON.stringify({ query: `mutation { ${fields.join(' ')} }` }));
    };
    const socketIp = freshIp();
    expect((await proxyGraphql(aliased(2), limited(), { socketIp })).status).toBe(200);
    received = undefined;
    expect((await proxyGraphql(post(MUTATION), limited(), { socketIp })).status).toBe(429);
    // more writes than the limit: refused even in a fresh window
    expect((await proxyGraphql(aliased(3), limited(), { socketIp: freshIp() })).status).toBe(429);
    expect(received).toBeUndefined(); // the API never saw either
  });

  it('never limits queries', async () => {
    const socketIp = freshIp();
    for (let i = 0; i < 5; i++)
      expect((await proxyGraphql(post(QUERY), limited(), { socketIp })).status).toBe(200);
    expect((await proxyGraphql(post(MUTATION), limited(), { socketIp })).status).toBe(200);
  });

  it('never counts a body it refuses (415, 413)', async () => {
    const socketIp = freshIp();
    const refused = (headers: Record<string, string>) =>
      proxyGraphql(post(MUTATION, headers), limited(), { socketIp }).then((res) => res.status);
    for (let i = 0; i < 2; i++) {
      expect(await refused({ 'content-type': 'text/plain' })).toBe(415);
      expect(await refused({ 'content-length': String(MAX_BODY_BYTES + 1) })).toBe(413);
    }
    // both writes of the window are still there
    for (let i = 0; i < 2; i++)
      expect((await proxyGraphql(post(MUTATION), limited(), { socketIp })).status).toBe(200);
  });

  it('counts per address in X-Real-IP, which it trusts by default', async () => {
    const socketIp = freshIp(); // the proxy in front: every client comes from it
    for (const ip of ['203.0.113.1', '203.0.113.1', '203.0.113.2'])
      expect((await proxyGraphql(writeFrom(ip), limited(), { socketIp })).status).toBe(200);
    expect((await proxyGraphql(writeFrom('203.0.113.1'), limited(), { socketIp })).status).toBe(
      429,
    );
    expect(received?.headers[CLIENT_IP_HEADER]).toBe('203.0.113.2');
  });

  it('ignores X-Forwarded-For, and X-Real-IP too when REAL_IP_HEADER is empty', async () => {
    const socketIp = freshIp();
    const direct = limited({ REAL_IP_HEADER: '' });
    for (const n of [1, 2])
      expect((await proxyGraphql(spoofed(n), direct, { socketIp })).status).toBe(200);
    expect((await proxyGraphql(spoofed(3), direct, { socketIp })).status).toBe(429);
  });

  it('is off with WRITE_RATE_LIMIT=off, and on the e2e servers (E2E=1)', async () => {
    const off: Record<string, string>[] = [{ WRITE_RATE_LIMIT: 'off' }, { E2E: '1' }];
    for (const overrides of off) {
      const socketIp = freshIp();
      for (let i = 0; i < 3; i++)
        expect((await proxyGraphql(post(MUTATION), limited(overrides), { socketIp })).status).toBe(
          200,
        );
    }
  });
});

describe('callInternalApi', () => {
  it('sends no secret header when none is configured (development)', async () => {
    await callInternalApi(env({ INTERNAL_API_SECRET: undefined }), QUERY);
    expect(received?.body).toBe(QUERY);
    expect(received?.headers).not.toHaveProperty(SECRET_HEADER);
    expect(received?.headers).not.toHaveProperty(CLIENT_IP_HEADER);
    expect(received?.headers[REQUEST_ID_HEADER]).toMatch(UUID); // SSR calls get an id too
  });

  it("aborts once the caller's signal aborts", async () => {
    const caller = new AbortController();
    const pending = callInternalApi(env(), HANG, { signal: caller.signal });
    await vi.waitFor(() => expect(received?.body).toBe(HANG));
    caller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  });

  it('gives up with a TimeoutError after timeoutMs', async () => {
    await expect(callInternalApi(env(), HANG, { timeoutMs: 50 })).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });
});
