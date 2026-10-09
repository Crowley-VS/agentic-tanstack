import { afterEach, describe, expect, it, vi } from 'vitest';
import { internalApiUrl, serverEnv } from './env.server';

const SECRET = 's'.repeat(32);
/** Everything production requires. */
const production = {
  NODE_ENV: 'production',
  INTERNAL_API_SECRET: SECRET,
  API_HOST: 'api.railway.internal',
  API_PORT: '8080',
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('serverEnv', () => {
  it('runs without a secret in development, against this machine', () => {
    expect(serverEnv({})).toEqual({
      NODE_ENV: 'development',
      API_HOST: 'localhost',
      API_PORT: 4000,
      INTERNAL_API_SECRET: undefined,
      REAL_IP_HEADER: 'x-real-ip',
      EDGE_REQUEST_ID_HEADER: 'x-railway-request-id',
      writeRateLimit: { limit: 10, windowMs: 60_000 },
    });
  });

  it('requires the secret when the runtime says production', () => {
    expect(() => serverEnv({ ...production, INTERNAL_API_SECRET: undefined })).toThrow(
      'INTERNAL_API_SECRET is required in production',
    );
    expect(serverEnv(production)).toMatchObject({ INTERNAL_API_SECRET: SECRET });
  });

  it('requires the secret in a production build, even when NODE_ENV is not set', () => {
    vi.stubEnv('PROD', true); // what `vite build` inlines as import.meta.env.PROD
    const { NODE_ENV: _, ...build } = production;
    expect(() => serverEnv({ ...build, INTERNAL_API_SECRET: undefined })).toThrow(
      'INTERNAL_API_SECRET is required in production',
    );
    expect(serverEnv(build).INTERNAL_API_SECRET).toBe(SECRET);
  });

  it("requires the API's address in production: no fallback to this machine", () => {
    const { API_HOST: _, API_PORT: __, ...rest } = production;
    expect(() => serverEnv(rest)).toThrow(
      /API_HOST: API_HOST is required in production\n {2}API_PORT: API_PORT is required/,
    );
    expect(() => serverEnv({ ...production, API_PORT: undefined })).toThrow(
      'API_PORT is required in production',
    );
    expect(serverEnv(production)).toMatchObject({
      API_HOST: 'api.railway.internal',
      API_PORT: 8080,
    });
  });

  it("requires the API's address in a production build too", () => {
    vi.stubEnv('PROD', true);
    expect(() => serverEnv({ INTERNAL_API_SECRET: SECRET })).toThrow(
      'API_HOST is required in production',
    );
  });

  it.each(['http://api', 'api:4000', '[fd12::1]', 'api/graphql', ''])(
    'refuses API_HOST=%j: a host name or IP address only',
    (API_HOST) => {
      expect(() => serverEnv({ API_HOST })).toThrow('API_HOST must be a host name or IP address');
    },
  );

  it.each(['0', '65536', 'http'])('refuses API_PORT=%j', (API_PORT) => {
    expect(() => serverEnv({ API_PORT })).toThrow('API_PORT');
  });

  it('refuses a secret shorter than 32 characters', () => {
    expect(() => serverEnv({ INTERNAL_API_SECRET: 'short' })).toThrow(
      'INTERNAL_API_SECRET must be at least 32 characters',
    );
  });

  it.each([
    ['5/30s', { limit: 5, windowMs: 30_000 }],
    ['100/1h', { limit: 100, windowMs: 3_600_000 }],
    [' 3/2m ', { limit: 3, windowMs: 120_000 }],
    ['off', null],
  ])('reads WRITE_RATE_LIMIT=%j', (WRITE_RATE_LIMIT, writeRateLimit) => {
    expect(serverEnv({ WRITE_RATE_LIMIT }).writeRateLimit).toEqual(writeRateLimit);
  });

  it.each(['10', '0/60s', '10/0s', '10/60', 'ten/60s', '10/60d', ''])(
    'refuses WRITE_RATE_LIMIT=%j',
    (WRITE_RATE_LIMIT) => {
      expect(() => serverEnv({ WRITE_RATE_LIMIT })).toThrow(
        'WRITE_RATE_LIMIT: must look like 10/60s, or be off',
      );
    },
  );

  it('turns the write rate limit off for the e2e servers (E2E=1)', () => {
    expect(serverEnv({ E2E: '1' }).writeRateLimit).toBeNull();
    expect(serverEnv({ E2E: '1', WRITE_RATE_LIMIT: '3/60s' }).writeRateLimit).toBeNull();
    expect(serverEnv({ E2E: '0' }).writeRateLimit).toEqual({ limit: 10, windowMs: 60_000 });
  });

  it('reads the client IP header in lower case; empty means the socket address', () => {
    expect(serverEnv({ REAL_IP_HEADER: ' CF-Connecting-IP ' }).REAL_IP_HEADER).toBe(
      'cf-connecting-ip',
    );
    expect(serverEnv({ REAL_IP_HEADER: '' }).REAL_IP_HEADER).toBe('');
  });

  it("reads the edge's request id header in lower case; empty means none", () => {
    expect(serverEnv({ EDGE_REQUEST_ID_HEADER: ' X-Amzn-Trace-Id ' }).EDGE_REQUEST_ID_HEADER).toBe(
      'x-amzn-trace-id',
    );
    expect(serverEnv({ EDGE_REQUEST_ID_HEADER: '' }).EDGE_REQUEST_ID_HEADER).toBe('');
  });

  it.each(['REAL_IP_HEADER', 'EDGE_REQUEST_ID_HEADER'])(
    'refuses a %s that is no header name: /api/health answers 503, not every request 500',
    (variable) => {
      // Headers.get() throws on these: they would fail every request that reads the header
      for (const value of ['X-Real-IP:', 'x real ip', 'x-réal-ip', 'x-real-ip\u0000'])
        expect(() => serverEnv({ [variable]: value })).toThrow(
          `${variable}: ${variable} must be a header name, or empty`,
        );
      expect(() => serverEnv({ [variable]: "x-a_b.c!#$%&'*+^`|~1" })).not.toThrow();
    },
  );
});

const url = (API_HOST: string) => internalApiUrl(serverEnv({ API_HOST, API_PORT: '4100' }));

describe('internalApiUrl', () => {
  it('points at the API graphql endpoint, with brackets around an IPv6 address', () => {
    expect(url('localhost')).toBe('http://localhost:4100/graphql');
    expect(url('api.railway.internal')).toBe('http://api.railway.internal:4100/graphql');
    expect(url('fd12:3456::1')).toBe('http://[fd12:3456::1]:4100/graphql');
    expect(url('10.0.0.5')).toBe('http://10.0.0.5:4100/graphql');
    for (const host of ['localhost', 'fd12:3456::1', 'my_api'])
      expect(() => new URL(url(host))).not.toThrow();
  });
});
