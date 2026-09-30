// The Yoga app's security defaults, through `yoga.fetch` (no server, no database: these queries
// never touch it, and the pool connects lazily).
import { createDb } from '@acme/db';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createApp } from './app';
import { loadEnv } from './env';
import { SECRET_HEADER } from './plugins/internal-secret';

const { db, close } = createDb({ url: 'postgres://nobody@127.0.0.1:1/none' });
afterAll(() => close());

const SECRET = 'x'.repeat(40);
const dev = createApp({ db, env: loadEnv({ DATABASE_URL: 'postgres://127.0.0.1/app' }) });
const prod = createApp({
  db,
  env: loadEnv({
    DATABASE_URL: 'postgres://127.0.0.1/app',
    NODE_ENV: 'production',
    INTERNAL_API_SECRET: SECRET,
  }),
});
const trusted = { [SECRET_HEADER]: SECRET };

type App = typeof dev;
type Result = { data?: Record<string, unknown>; errors?: { message: string }[] };
async function query(app: App, source: string, headers: Record<string, string> = {}) {
  const res = await app.fetch('http://api/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ query: source }),
  });
  return { status: res.status, body: (await res.json()) as Result };
}
const messages = (body: Result) => (body.errors ?? []).map((e) => e.message).join('\n');

describe('api app', () => {
  it('answers the health check without the secret', async () => {
    for (const app of [dev, prod]) expect((await app.fetch('http://api/health')).status).toBe(200);
  });

  it('serves the schema, reading APP_VERSION when the field resolves', async () => {
    vi.stubEnv('APP_VERSION', '1.2.3');
    try {
      expect((await query(prod, '{ apiVersion }', trusted)).body).toEqual({
        data: { apiVersion: '1.2.3' },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('requires the internal secret whenever it is set', async () => {
    expect((await query(prod, '{ apiVersion }')).status).toBe(401);
    expect((await query(prod, '{ apiVersion }', { [SECRET_HEADER]: 'y'.repeat(40) })).status).toBe(
      401,
    );
    expect((await query(prod, '{ apiVersion }', trusted)).status).toBe(200);
    // not set (development): open
    expect((await query(dev, '{ apiVersion }')).status).toBe(200);
  });

  it('blocks requests a browser could send cross-site without a preflight (CSRF)', async () => {
    const get = (headers: Record<string, string> = {}) =>
      dev.fetch('http://api/graphql?query=%7BapiVersion%7D', {
        headers: { accept: 'application/json', ...headers },
      });
    expect((await get()).status).toBe(403);
    expect((await get({ 'x-graphql-yoga-csrf': '1' })).status).toBe(200);
    const form = await dev.fetch('http://api/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'query=%7BapiVersion%7D',
    });
    expect(form.status).toBe(403);
  });

  it('allows introspection, GraphiQL and field suggestions only in development', async () => {
    const introspect = '{ __schema { queryType { name } } }';
    expect((await query(dev, introspect)).body.data).toEqual({
      __schema: { queryType: { name: 'Query' } },
    });
    expect(messages((await query(prod, introspect, trusted)).body)).toContain(
      'introspection has been disabled',
    );

    const html = { accept: 'text/html' };
    const page = (app: App, headers: Record<string, string>) =>
      app.fetch('http://api/graphql', { headers: { ...html, ...headers } });
    expect((await page(dev, {})).headers.get('content-type')).toContain('text/html');
    const prodPage = await page(prod, trusted);
    expect(prodPage.headers.get('content-type') ?? '').not.toContain('text/html');
    expect(await prodPage.text()).not.toContain('<html');

    expect(messages((await query(dev, '{ apiVersio }')).body)).toContain('Did you mean');
    expect(messages((await query(prod, '{ apiVersio }', trusted)).body)).not.toContain(
      'Did you mean',
    );
  });

  it('rejects abusive operations before executing them', async () => {
    const aliases = Array.from({ length: 16 }, (_, i) => `a${i}: apiVersion`).join(' ');
    expect(messages((await query(dev, `{ ${aliases} }`)).body)).toMatch(/aliases/i);
    const directives = Array.from({ length: 11 }, () => '@include(if: true)').join(' ');
    expect(messages((await query(dev, `{ apiVersion ${directives} }`)).body)).toMatch(
      /directives/i,
    );
  });
});
