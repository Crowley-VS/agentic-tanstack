import { describe, expect, it } from 'vitest';
import { listenHost, listenPort, loadEnv, urlHost } from './env';

const DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/app';
const SECRET = 's'.repeat(32);

describe('loadEnv', () => {
  it('defaults to development, a pool of 10 and port 4000', () => {
    const env = loadEnv({ DATABASE_URL });
    expect(env).toMatchObject({ NODE_ENV: 'development', DB_POOL_MAX: 10 });
    expect(listenPort(env)).toBe(4000);
  });

  it("listens on the platform's PORT, else this checkout's API_PORT", () => {
    expect(listenPort(loadEnv({ DATABASE_URL, API_PORT: '23901' }))).toBe(23901);
    expect(listenPort(loadEnv({ DATABASE_URL, API_PORT: '23901', PORT: '8080' }))).toBe(8080);
  });

  it('listens on this machine only in development, everywhere in production, unless LISTEN_HOST is set', () => {
    const production = { DATABASE_URL, NODE_ENV: 'production', INTERNAL_API_SECRET: SECRET };
    expect(listenHost(loadEnv({ DATABASE_URL }))).toBe('127.0.0.1');
    expect(listenHost(loadEnv({ DATABASE_URL, HOST: 'my-laptop' }))).toBe('127.0.0.1'); // ignored
    expect(listenHost(loadEnv(production))).toBe('::');
    // a production-mode run that only this machine can reach (e2e)
    expect(listenHost(loadEnv({ ...production, LISTEN_HOST: '127.0.0.1' }))).toBe('127.0.0.1');
    expect(listenHost(loadEnv({ DATABASE_URL, LISTEN_HOST: '::' }))).toBe('::');
  });

  it('names the address it listens on in its startup URL: localhost when that reaches it', () => {
    for (const host of ['::', '0.0.0.0', '::1', '127.0.0.1'])
      expect(urlHost(host)).toBe('localhost');
    expect(urlHost('10.0.0.5')).toBe('10.0.0.5');
    expect(urlHost('fd12:3456::1')).toBe('[fd12:3456::1]');
    expect(urlHost('api.railway.internal')).toBe('api.railway.internal');
  });

  it('takes the version and the log format, and refuses a log format it does not know', () => {
    const unset = loadEnv({ DATABASE_URL });
    expect([unset.APP_VERSION, unset.LOG_FORMAT]).toEqual([undefined, undefined]);
    expect(loadEnv({ DATABASE_URL, APP_VERSION: '9f2c1ab', LOG_FORMAT: 'json' })).toMatchObject({
      APP_VERSION: '9f2c1ab',
      LOG_FORMAT: 'json',
    });
    expect(() => loadEnv({ DATABASE_URL, LOG_FORMAT: 'yaml' })).toThrow('LOG_FORMAT');
    expect(() => loadEnv({ DATABASE_URL, APP_VERSION: ' ' })).toThrow('APP_VERSION');
  });

  it('needs a Postgres DATABASE_URL', () => {
    expect(() => loadEnv({})).toThrow('DATABASE_URL');
    expect(() => loadEnv({ DATABASE_URL: 'mysql://root@127.0.0.1/app' })).toThrow('DATABASE_URL');
    expect(
      loadEnv({ DATABASE_URL: 'postgresql://u:p@db.railway.internal:5432/railway' }),
    ).toBeDefined();
  });

  it('refuses to start in production without an INTERNAL_API_SECRET of 32+ characters', () => {
    const production = { DATABASE_URL, NODE_ENV: 'production' };
    expect(() => loadEnv(production)).toThrow('INTERNAL_API_SECRET is required in production');
    expect(() => loadEnv({ ...production, INTERNAL_API_SECRET: 'short' })).toThrow(
      'at least 32 characters',
    );
    expect(loadEnv({ ...production, INTERNAL_API_SECRET: SECRET }).INTERNAL_API_SECRET).toBe(
      SECRET,
    );
  });

  it('lists every problem at once', () => {
    expect(() => loadEnv({ NODE_ENV: 'staging', DB_POOL_MAX: '0' })).toThrow(
      /NODE_ENV[\s\S]*DATABASE_URL[\s\S]*DB_POOL_MAX/,
    );
  });
});
