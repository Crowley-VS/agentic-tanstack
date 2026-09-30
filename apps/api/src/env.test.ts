import { describe, expect, it } from 'vitest';
import { listenPort, loadEnv } from './env';

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
