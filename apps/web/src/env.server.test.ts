import { afterEach, describe, expect, it, vi } from 'vitest';
import { internalApiUrl, serverEnv } from './env.server';

const SECRET = 's'.repeat(32);

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
    });
  });

  it('requires the secret when the runtime says production', () => {
    expect(() => serverEnv({ NODE_ENV: 'production' })).toThrow(
      'INTERNAL_API_SECRET is required in production',
    );
    expect(serverEnv({ NODE_ENV: 'production', INTERNAL_API_SECRET: SECRET })).toMatchObject({
      INTERNAL_API_SECRET: SECRET,
    });
  });

  it('requires the secret in a production build, even when NODE_ENV is not set', () => {
    vi.stubEnv('PROD', true); // what `vite build` inlines as import.meta.env.PROD
    expect(() => serverEnv({})).toThrow('INTERNAL_API_SECRET is required in production');
    expect(serverEnv({ INTERNAL_API_SECRET: SECRET }).INTERNAL_API_SECRET).toBe(SECRET);
  });

  it('refuses a secret shorter than 32 characters', () => {
    expect(() => serverEnv({ INTERNAL_API_SECRET: 'short' })).toThrow(
      'INTERNAL_API_SECRET must be at least 32 characters',
    );
  });
});

const url = (API_HOST: string) => internalApiUrl(serverEnv({ API_HOST, API_PORT: '4100' }));

describe('internalApiUrl', () => {
  it('points at the API graphql endpoint, with brackets around an IPv6 address', () => {
    expect(url('localhost')).toBe('http://localhost:4100/graphql');
    expect(url('api.railway.internal')).toBe('http://api.railway.internal:4100/graphql');
    expect(url('fd12:3456::1')).toBe('http://[fd12:3456::1]:4100/graphql');
  });
});
