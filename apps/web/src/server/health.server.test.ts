import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { health } from './health.server';

const SECRET = 's'.repeat(32);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('GET /api/health', () => {
  it('answers 200, never cached, when the environment is valid', async () => {
    for (const env of [{}, { NODE_ENV: 'production', INTERNAL_API_SECRET: SECRET }]) {
      const res = health(env);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ status: 'ok' });
    }
  });

  it('answers 503 with a generic body when production has no secret, logging why', async () => {
    const res = health({ NODE_ENV: 'production' });
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ status: 'unavailable' });
    expect(console.error).toHaveBeenCalledWith(
      '[web] /api/health:',
      expect.stringContaining('INTERNAL_API_SECRET is required in production'),
    );
  });

  it('answers 503 for a production build started without NODE_ENV or a secret', () => {
    vi.stubEnv('PROD', true);
    expect(health({}).status).toBe(503);
  });

  it('answers 503 for a secret that is too short, without echoing it', async () => {
    const res = health({ INTERNAL_API_SECRET: 'not-long-enough' });
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('not-long-enough');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('not-long-enough');
  });
});
