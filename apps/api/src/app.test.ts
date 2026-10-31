// The Yoga app's security defaults, through `yoga.fetch` (no server, no database: these queries
// never touch it, and the pool connects lazily).
import { createDb } from '@acme/db';
import { createLogger, type LogFormat } from '@acme/logger';
import { CLIENT_IP_HEADER, REQUEST_ID_HEADER, SECRET_HEADER } from '@acme/validators/internal-api';
import { execute, parse } from 'graphql';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createApp } from './app';
import { loadEnv } from './env';
import { schema } from './graphql/schema';

const { db, close } = createDb({ url: 'postgres://nobody@127.0.0.1:1/none' });
afterAll(() => close());

const SECRET = 'x'.repeat(40);
const dev = createApp({ db, env: loadEnv({ DATABASE_URL: 'postgres://127.0.0.1/app' }) });
// how `api:dev` really runs: Nx loads the root .env, which sets the secret, into every task
const devWithSecret = createApp({
  db,
  env: loadEnv({ DATABASE_URL: 'postgres://127.0.0.1/app', INTERNAL_API_SECRET: SECRET }),
});
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
async function query(
  app: App,
  source: string,
  headers: Record<string, string> = {},
  url = 'http://api/graphql',
) {
  const res = await app.fetch(url, {
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

  it('requires the internal secret in production, on every GraphQL request', async () => {
    expect((await query(prod, '{ apiVersion }')).status).toBe(401);
    expect((await query(prod, '{ apiVersion }', { [SECRET_HEADER]: 'y'.repeat(40) })).status).toBe(
      401,
    );
    expect((await query(prod, '{ apiVersion }', trusted)).status).toBe(200);
    // Yoga runs any URL ending in /graphql as GraphQL: a /health path must not skip the check
    for (const url of [
      'http://api/health?/graphql',
      'http://api/health?x=/graphql',
      'http://api/health?/graphql/',
      'http://api/health#/graphql',
    ])
      expect((await query(prod, '{ apiVersion }', {}, url)).status, url).toBe(401);
  });

  it('ignores the internal secret in development, even when .env sets it', async () => {
    for (const app of [dev, devWithSecret])
      expect((await query(app, '{ apiVersion }')).status).toBe(200);
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
    // each message names the configured limit, so raising or lowering one fails here (the
    // template's SECURITY.md promises these numbers)
    const aliases = Array.from({ length: 16 }, (_, i) => `a${i}: apiVersion`).join(' ');
    expect(messages((await query(dev, `{ ${aliases} }`)).body)).toContain(
      'Aliases limit of 15 exceeded, found 16.',
    );
    const directives = Array.from({ length: 11 }, () => '@include(if: true)').join(' ');
    expect(messages((await query(dev, `{ apiVersion ${directives} }`)).body)).toContain(
      'Directives limit of 10 exceeded, found 11.',
    );
    expect(messages((await query(dev, nested(11))).body)).toContain(
      'Query depth limit of 10 exceeded, found 11.',
    );
    // `{`, 1,999 fields and `}`: one token over
    expect(messages((await query(dev, `{ ${'apiVersion '.repeat(1999)}}`)).body)).toContain(
      'Token limit of 2000 exceeded.',
    );
    // graphql-armor's own price, not the schema's complexity: a page of 1,000 costs 7,250
    expect(
      messages((await query(dev, '{ notes(first: 1000) { edges { cursor } } }')).body),
    ).toContain('Query Cost limit of 5000 exceeded');
  });

  it('limits depth in the schema too, behind graphql-armor (Pothos complexity)', async () => {
    // executed without Yoga's validation rules, so graphql-armor's depth limit never sees it
    const result = await execute({
      schema,
      document: parse(nested(11)),
      contextValue: { db, readOnly: false },
    });
    expect(result.errors?.map((e) => e.message)).toEqual([
      'Query exceeds maximum depth (depth: 11, max: 10)',
    ]);
  });

  it('sends no CORS headers: a page on another origin can read none of its answers', async () => {
    const origin = { origin: 'https://elsewhere.example' };
    for (const app of [dev, prod]) {
      const preflight = await app.fetch('http://api/graphql', {
        method: 'OPTIONS',
        headers: {
          ...origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
      const post = await app.fetch('http://api/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...origin, ...trusted },
        body: JSON.stringify({ query: '{ apiVersion }' }),
      });
      expect(post.status).toBe(200);
      expect(post.headers.get('access-control-allow-origin')).toBeNull();
    }
  });
});

/** A query `depth` fields deep: a note, then comment lists and their notes, ending in an id. */
function nested(depth: number) {
  const fields = Array.from({ length: depth - 1 }, (_, i) =>
    i === 0 ? 'note(id: "0199aa00-0000-7000-8000-000000000001")' : i % 2 ? 'comments' : 'note',
  );
  return `{ ${fields.reduceRight((inner, field) => `${field} { ${inner} }`, 'id')} }`;
}

/** An app whose log lines go to `lines`. */
function logged(env: Record<string, string>, format: LogFormat = 'text') {
  const lines: string[] = [];
  const log = createLogger({ app: 'api', format, write: (line) => lines.push(line) });
  const app = createApp({
    db,
    env: loadEnv({ DATABASE_URL: 'postgres://127.0.0.1/app', ...env }),
    log,
  });
  return { app, lines };
}

describe('request log', () => {
  const forwarded = { [CLIENT_IP_HEADER]: '203.0.113.7', [REQUEST_ID_HEADER]: 'req-1' };

  it("logs one line per request, with the web server's client IP and request id", async () => {
    const { app, lines } = logged({ NODE_ENV: 'production', INTERNAL_API_SECRET: SECRET });
    await query(app, '{ apiVersion }', { ...trusted, ...forwarded });
    expect(lines).toEqual([
      expect.stringMatching(/^\[api\] 200 POST \/graphql \d+ms ip=203\.0\.113\.7 id=req-1$/),
    ]);
  });

  it('ignores the forwarded values without the secret, and still logs the 401', async () => {
    const { app, lines } = logged({ NODE_ENV: 'production', INTERNAL_API_SECRET: SECRET });
    await query(app, '{ apiVersion }', forwarded);
    await query(app, '{ apiVersion }', { ...forwarded, [SECRET_HEADER]: 'y'.repeat(40) });
    expect(lines).toEqual([
      expect.stringMatching(/^\[api\] 401 POST \/graphql \d+ms ip=- id=-$/),
      expect.stringMatching(/^\[api\] 401 POST \/graphql \d+ms ip=- id=-$/),
    ]);
  });

  it('trusts them in development only when the configured secret matches', async () => {
    const withSecret = logged({ INTERNAL_API_SECRET: SECRET });
    await query(withSecret.app, '{ apiVersion }', { ...trusted, ...forwarded });
    await query(withSecret.app, '{ apiVersion }', forwarded);
    expect(withSecret.lines).toEqual([
      expect.stringContaining('200 POST /graphql'),
      expect.stringContaining('200 POST /graphql'),
    ]);
    expect(withSecret.lines[0]).toMatch(/ ip=203\.0\.113\.7 id=req-1$/);
    expect(withSecret.lines[1]).toMatch(/ ip=- id=-$/);
    const without = logged({});
    await query(without.app, '{ apiVersion }', { ...trusted, ...forwarded });
    expect(without.lines).toEqual([expect.stringMatching(/ ip=- id=-$/)]);
  });

  it('logs an empty forwarded value as missing', async () => {
    const { app, lines } = logged({ NODE_ENV: 'production', INTERNAL_API_SECRET: SECRET });
    await query(app, '{ apiVersion }', {
      ...trusted,
      [CLIENT_IP_HEADER]: '',
      [REQUEST_ID_HEADER]: '',
    });
    expect(lines).toEqual([expect.stringMatching(/ ip=- id=-$/)]);
  });

  it('logs the socket address of a client that hangs up before the answer', async () => {
    const { app, lines } = logged({});
    // node:http's socket, as main.ts hands it to Yoga: its address is gone once the client leaves
    const socket: { remoteAddress?: string } = { remoteAddress: '198.51.100.9' };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        socket.remoteAddress = undefined; // the client hangs up while its body is read
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ query: '{ apiVersion }' })));
        controller.close();
      },
    });
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    };
    await app.fetch('http://api/graphql', init, { req: { socket } });
    expect(lines).toEqual([expect.stringMatching(/ ip=198\.51\.100\.9 id=-$/)]);
  });

  it("leaves the health check and (in development) GraphiQL's page out", async () => {
    const { app, lines } = logged({});
    expect((await app.fetch('http://api/health')).status).toBe(200);
    const page = await app.fetch('http://api/graphql', { headers: { accept: 'text/html' } });
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(lines).toEqual([]);
  });

  it('logs an unexpected error with its stack and request id; the client sees it masked', async () => {
    // the database is unreachable here: the notes query fails inside its resolver
    const { app, lines } = logged({ NODE_ENV: 'production', INTERNAL_API_SECRET: SECRET }, 'json');
    const res = await query(app, '{ notes(first: 1) { edges { cursor } } }', {
      ...trusted,
      ...forwarded,
    });
    expect(messages(res.body)).toBe('Unexpected error.');
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      expect.objectContaining({
        level: 'error',
        app: 'api',
        message: expect.stringContaining('Failed query'),
        requestId: 'req-1',
        // Yoga's GraphQLError, then what the resolver threw (graphql-js's originalError), then why
        // the query failed: the driver's error
        err: {
          name: 'GraphQLError',
          message: expect.stringContaining('Failed query'),
          cause: {
            name: 'DrizzleQueryError',
            message: expect.stringContaining('Failed query'),
            stack: expect.any(String),
            cause: expect.objectContaining({
              message: expect.stringContaining('ECONNREFUSED 127.0.0.1:1'),
            }),
          },
        },
      }),
      expect.objectContaining({
        level: 'info',
        status: 200,
        requestId: 'req-1',
        ip: '203.0.113.7',
      }),
    ]);
  });
});
