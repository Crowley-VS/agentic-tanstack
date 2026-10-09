// The request middleware's work (start.ts runs it around every request): the log line, the request
// id on the answer, `connection: close` while shutting down, and when it listens for SIGTERM.
import { EventEmitter } from 'node:events';
import { REQUEST_ID_HEADER } from '@acme/validators/internal-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logRequest, sigtermFlag } from './request-log.server';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
const SOCKET = '10.0.0.2'; // the proxy in front
const options = { socketIp: () => SOCKET, draining: () => false };
const answer = (response: Response) => () => Promise.resolve({ response });
/** A request whose handling throws. */
const failing = () => Promise.reject(new Error('boom'));
const request = (path: string, headers: Record<string, string> = {}, signal?: AbortSignal) =>
  new Request(`http://web.test${path}`, { headers, signal });
/** The text lines written so far (tests run with NODE_ENV=test: text format). */
const lines = () =>
  [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls].map(([line]) =>
    String(line),
  );

describe('logRequest', () => {
  it("logs one line with the client's IP and the edge's request id, and answers with the id", async () => {
    const req = request('/notes/1', {
      'x-real-ip': '203.0.113.7',
      'x-railway-request-id': 'edge-1',
      [REQUEST_ID_HEADER]: 'client-chosen',
    });
    const { response } = await logRequest(req, answer(new Response('<html>')), options);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe('edge-1');
    expect(response.headers.has('connection')).toBe(false);
    expect(lines()).toEqual([
      expect.stringMatching(/^\[web\] 200 GET \/notes\/1 \d+ms ip=203\.0\.113\.7 id=edge-1$/),
    ]);
  });

  it("takes a client's x-request-id without an edge id, and makes one up without either", async () => {
    await logRequest(
      request('/', { [REQUEST_ID_HEADER]: 'req-9' }),
      answer(new Response()),
      options,
    );
    const { response } = await logRequest(request('/'), answer(new Response()), options);
    expect(lines()[0]).toMatch(/ ip=10\.0\.0\.2 id=req-9$/);
    expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(UUID);
    expect(lines()[1]).toContain(`id=${response.headers.get(REQUEST_ID_HEADER)}`);
  });

  it('keeps an id the answer already has (the BFF sets its own, the same one)', async () => {
    const res = new Response(null, { headers: { [REQUEST_ID_HEADER]: 'from-bff' } });
    await logRequest(request('/api/graphql'), answer(res), options);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe('from-bff');
  });

  it('leaves the health check out of the log', async () => {
    await logRequest(request('/api/health'), answer(Response.json({ status: 'ok' })), options);
    expect(lines()).toEqual([]);
  });

  it('logs a 5xx answer as an error, and 500 for a request that throws', async () => {
    await logRequest(request('/'), answer(new Response(null, { status: 502 })), options);
    await expect(logRequest(request('/api/graphql'), failing, options)).rejects.toThrow('boom');
    expect(vi.mocked(console.error).mock.calls.map(([line]) => String(line))).toEqual([
      expect.stringMatching(/^\[web\] 502 GET \/ \d+ms /),
      expect.stringMatching(/^\[web\] 500 GET \/api\/graphql \d+ms /),
    ]);
  });

  it('logs 499 for a request whose connection closed before the answer', async () => {
    const closed = new AbortController();
    closed.abort();
    const aborted = () => Promise.reject(closed.signal.reason);
    await expect(logRequest(request('/', {}, closed.signal), aborted, options)).rejects.toThrow();
    expect(lines()).toEqual([expect.stringMatching(/^\[web\] 499 GET \/ /)]);
  });

  it('asks the client to close its connection once the server is shutting down', async () => {
    const { response } = await logRequest(request('/'), answer(new Response()), {
      ...options,
      draining: () => true,
    });
    expect(response.headers.get('connection')).toBe('close');
    // a redirect's headers cannot change: it goes out as it is
    const redirect = Response.redirect('http://web.test/', 308);
    await logRequest(request('/old'), answer(redirect), { ...options, draining: () => true });
    expect(lines()[1]).toMatch(/^\[web\] 308 GET \/old /);
  });

  it('believes no proxy header while the environment is invalid', async () => {
    vi.stubEnv('NODE_ENV', 'production'); // and no secret: invalid
    const req = request('/', { 'x-real-ip': '203.0.113.7', 'x-railway-request-id': 'edge-2' });
    await logRequest(req, answer(new Response()), options);
    expect(lines()[0]).toMatch(/ ip=10\.0\.0\.2 id=[\da-f-]{36}$/);
  });
});

describe('sigtermFlag', () => {
  it('turns true on SIGTERM when another listener (srvx) handles the signal', () => {
    const proc = new EventEmitter();
    proc.on('SIGTERM', () => {});
    const draining = sigtermFlag(proc);
    expect(draining()).toBe(false);
    proc.emit('SIGTERM');
    expect(draining()).toBe(true);
    expect(lines()).toEqual(['[web] SIGTERM: finishing in-flight requests, then exiting']);
  });

  it('adds no listener when nothing else handles SIGTERM (CI or TEST set: Node exits at once)', () => {
    const proc = new EventEmitter();
    sigtermFlag(proc);
    expect(proc.listenerCount('SIGTERM')).toBe(0);
  });
});
