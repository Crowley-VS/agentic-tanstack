import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { serverEnv } from '../env.server';
import {
  MAX_BODY_BYTES,
  methodNotAllowed,
  proxyGraphql,
  readBodyText,
} from './graphql-proxy.server';
import { callInternalApi } from './internal-api.server';

const SECRET = 's'.repeat(32);
/** A request body that makes the stub API never answer. */
const HANG = '{"query":"{ hang }"}';
let upstream: Server;
let port: number;
let received: { headers: IncomingHttpHeaders; body: string } | undefined;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      received = { headers: req.headers, body };
      if (body === HANG) return;
      res.writeHead(200, { 'content-type': 'application/graphql-response+json' });
      res.end(JSON.stringify({ data: { ok: true } }));
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
    const res = await proxyGraphql(post('{"query":"{ ok }"}', { cookie: 'a=b' }), env());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/graphql-response+json');
    expect(await res.json()).toEqual({ data: { ok: true } });
    expect(received?.body).toBe('{"query":"{ ok }"}');
    expect(received?.headers['x-internal-secret']).toBe(SECRET);
    expect(received?.headers.cookie).toBeUndefined(); // browser headers are not forwarded
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

  it('refuses anything but application/json', async () => {
    const res = await proxyGraphql(post('query=1', { 'content-type': 'text/plain' }), env());
    expect(res.status).toBe(415);
    expect(received).toBeUndefined();
  });

  it('answers 502 when the API is down', async () => {
    const res = await proxyGraphql(post('{}'), env({ API_PORT: '1' }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ errors: [{ message: 'API unavailable' }] });
  });

  it('stops waiting for the API once the browser goes away', async () => {
    const browser = new AbortController();
    const pending = proxyGraphql(post(HANG, {}, browser.signal), env());
    await vi.waitFor(() => expect(received?.body).toBe(HANG));
    browser.abort();
    expect((await pending).status).toBe(502);
  });

  it('answers 405 with Allow: POST for other methods', () => {
    const res = methodNotAllowed();
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});

describe('callInternalApi', () => {
  it('sends no secret header when none is configured (development)', async () => {
    await callInternalApi(env({ INTERNAL_API_SECRET: undefined }), '{"query":"{ ok }"}');
    expect(received?.body).toBe('{"query":"{ ok }"}');
    expect(received?.headers).not.toHaveProperty('x-internal-secret');
  });

  it("aborts once the caller's signal aborts", async () => {
    const caller = new AbortController();
    const pending = callInternalApi(env(), HANG, { signal: caller.signal });
    await vi.waitFor(() => expect(received?.body).toBe(HANG));
    caller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  });
});
