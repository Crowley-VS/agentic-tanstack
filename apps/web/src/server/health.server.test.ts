import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { health } from './health.server';

const SECRET = 's'.repeat(32);
/** Everything production requires. */
const production = {
  NODE_ENV: 'production',
  INTERNAL_API_SECRET: SECRET,
  API_HOST: 'api.railway.internal',
  API_PORT: '8080',
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('GET /api/health', () => {
  it('answers 200, never cached, when the environment is valid', async () => {
    for (const env of [{}, production]) {
      const res = health(env);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ status: 'ok', version: 'dev' });
    }
  });

  it('says which version is deployed (APP_VERSION)', async () => {
    expect(await health({ ...production, APP_VERSION: '9f2c1ab' }).json()).toEqual({
      status: 'ok',
      version: '9f2c1ab',
    });
  });

  it('answers 503 with a generic body when production has no secret, logging why', async () => {
    const res = health({ NODE_ENV: 'production' });
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ status: 'unavailable' });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[web\] \/api\/health: invalid web environment:\n.*INTERNAL_API_SECRET is required in production/,
      ),
    );
  });

  it('answers 503 when production has no API address (no fallback to this machine)', () => {
    const { API_HOST: _, ...noHost } = production;
    expect(health(noHost).status).toBe(503);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('API_HOST is required in production'),
    );
  });

  it('answers 503 for a proxy header setting that names no header (else every BFF call fails)', () => {
    for (const variable of ['REAL_IP_HEADER', 'EDGE_REQUEST_ID_HEADER'])
      expect(health({ ...production, [variable]: 'X-Real-IP:' }).status).toBe(503);
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
