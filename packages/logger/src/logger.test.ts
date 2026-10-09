import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, type Level, type LogFormat, logFormat, type LoggerOptions } from './logger';

const NOW = new Date('2026-10-08T12:00:00.000Z');

/** A logger whose lines go to `lines`, with a fixed clock. */
function collect(format: LogFormat, options: Partial<LoggerOptions> = {}) {
  const lines: { line: string; level: Level }[] = [];
  const log = createLogger({
    app: 'api',
    format,
    version: 'abc1234',
    now: () => NOW,
    write: (line, level) => lines.push({ line, level }),
    ...options,
  });
  return { log, lines, parsed: () => lines.map(({ line }) => JSON.parse(line) as unknown) };
}

const request = {
  method: 'POST',
  path: '/graphql',
  status: 200,
  ms: 12,
  ip: '203.0.113.7',
  requestId: 'req-1',
};

/** The messages down a JSON line's `err`, cause by cause. */
function causeChain(line: unknown): unknown[] {
  const messages: unknown[] = [];
  let at: unknown = Reflect.get(Object(line), 'err');
  while (at instanceof Object) {
    messages.push(Reflect.get(at, 'message'));
    at = Reflect.get(at, 'cause');
  }
  return messages;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logFormat', () => {
  it('is JSON in production and text elsewhere, unless LOG_FORMAT says otherwise', () => {
    expect(logFormat({ NODE_ENV: 'production' })).toBe('json');
    expect(logFormat({})).toBe('text');
    expect(logFormat({ NODE_ENV: 'test' })).toBe('text');
    expect(logFormat({ NODE_ENV: 'production', LOG_FORMAT: 'text' })).toBe('text');
    expect(logFormat({ LOG_FORMAT: 'json' })).toBe('json');
    expect(logFormat({ NODE_ENV: 'production', LOG_FORMAT: 'yaml' })).toBe('json');
  });
});

describe('JSON lines (production)', () => {
  it('writes one object per request, in the shape Railway parses (message, level)', () => {
    const { log, lines, parsed } = collect('json');
    log.request(request);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.line).not.toContain('\n');
    expect(parsed()).toEqual([
      {
        time: '2026-10-08T12:00:00.000Z',
        level: 'info',
        app: 'api',
        version: 'abc1234',
        message: '200 POST /graphql 12ms',
        requestId: 'req-1',
        method: 'POST',
        path: '/graphql',
        status: 200,
        ms: 12,
        ip: '203.0.113.7',
      },
    ]);
  });

  it('logs a 5xx answer at error level, and leaves out what it does not know', () => {
    const { log, lines, parsed } = collect('json', { version: undefined });
    log.request({ method: 'GET', path: '/', status: 502, ms: 3 });
    expect(lines[0]?.level).toBe('error');
    expect(parsed()[0]).toEqual({
      time: '2026-10-08T12:00:00.000Z',
      level: 'error',
      app: 'api',
      message: '502 GET / 3ms',
      method: 'GET',
      path: '/',
      status: 502,
      ms: 3,
    });
  });

  it('writes an error with its stack and causes, on one line', () => {
    const { log, lines, parsed } = collect('json');
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:4000');
    log.error('/api/graphql: API unavailable', {
      requestId: 'req-2',
      err: new TypeError('fetch failed', { cause }),
    });
    expect(lines[0]?.line).not.toContain('\n');
    expect(parsed()[0]).toMatchObject({
      level: 'error',
      message: '/api/graphql: API unavailable',
      requestId: 'req-2',
      err: {
        name: 'TypeError',
        message: 'fetch failed',
        stack: expect.stringContaining('TypeError: fetch failed\n    at '),
        cause: { name: 'Error', message: 'connect ECONNREFUSED 127.0.0.1:4000' },
      },
    });
  });

  it("follows a GraphQLError's originalError to the root cause, writing the shared stack once", () => {
    const { log, parsed } = collect('json');
    const driver = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    const query = new Error('Failed query: select 1', { cause: driver });
    query.name = 'DrizzleQueryError';
    // as graphql-js wraps a resolver's error: on a non-enumerable originalError, its stack copied
    const wrapper = new Error(query.message);
    wrapper.name = 'GraphQLError';
    Object.defineProperty(wrapper, 'originalError', { value: query, enumerable: false });
    wrapper.stack = query.stack;
    log.error(wrapper.message, { err: wrapper });
    expect(parsed()[0]).toHaveProperty('err', {
      name: 'GraphQLError',
      message: 'Failed query: select 1',
      cause: {
        name: 'DrizzleQueryError',
        message: 'Failed query: select 1',
        stack: query.stack,
        cause: { name: 'Error', message: driver.message, stack: driver.stack },
      },
    });
  });

  it('writes at most three causes, and an error that wraps no Error without one', () => {
    const { log, parsed } = collect('json');
    let err = new Error('5');
    for (const n of [4, 3, 2, 1]) err = new Error(String(n), { cause: err });
    const odd = new Error('odd');
    Object.defineProperty(odd, 'originalError', { value: 'not an error' });
    log.error('deep', { err });
    log.error('odd', { err: odd });
    expect(causeChain(parsed()[0])).toEqual(['1', '2', '3', '4']);
    expect(parsed()[1]).toHaveProperty('err', {
      name: 'Error',
      message: 'odd',
      stack: expect.any(String),
    });
  });

  it("never lets a field replace the line's own keys, and survives fields JSON cannot hold", () => {
    const { log, parsed } = collect('json');
    log.warn('careful', { level: 'info', message: 'other', app: 'web', count: 2 });
    log.info('odd', { big: 1n });
    expect(parsed()).toEqual([
      expect.objectContaining({ level: 'warn', message: 'careful', app: 'api', count: 2 }),
      expect.objectContaining({
        level: 'info',
        message: 'odd',
        logError: expect.stringContaining('BigInt'),
      }),
    ]);
  });

  it('goes to stdout at every level: Railway marks each stderr line an error', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createLogger({ app: 'web', format: 'json' });
    log.error('boom');
    log.request({ ...request, status: 500 });
    expect(out).toHaveBeenCalledTimes(2);
    expect(err).not.toHaveBeenCalled();
  });
});

describe('text lines (development)', () => {
  it('keeps the request line people and agents grep for', () => {
    const { log, lines } = collect('text');
    log.request(request);
    log.request({ method: 'POST', path: '/graphql', status: 401, ms: 1 });
    expect(lines.map(({ line }) => line)).toEqual([
      '[api] 200 POST /graphql 12ms ip=203.0.113.7 id=req-1',
      '[api] 401 POST /graphql 1ms ip=- id=-',
    ]);
  });

  it('writes fields as key=value and the error with its stack below the line', () => {
    const { log, lines } = collect('text');
    log.info('listening', {
      url: 'http://localhost:4000/graphql',
      note: 'two words',
      skipped: undefined,
    });
    log.error('SSR: a page failed to load', {
      requestId: 'req-3',
      err: new Error('API unavailable'),
    });
    expect(lines[0]).toEqual({
      line: '[api] listening url=http://localhost:4000/graphql note="two words"',
      level: 'info',
    });
    expect(lines[1]?.level).toBe('error');
    expect(lines[1]?.line).toMatch(
      /^\[api\] SSR: a page failed to load requestId=req-3\nError: API unavailable\n {4}at /,
    );
  });

  it('sends warnings and errors to stderr, the rest to stdout', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createLogger({ app: 'web', format: 'text' });
    log.info('a');
    log.warn('b');
    log.error('c');
    expect(out.mock.calls).toEqual([['[web] a']]);
    expect(err.mock.calls).toEqual([['[web] b'], ['[web] c']]);
  });
});
