// The real entry points, run as processes the way the platform runs them (from source, via tsx):
// main.ts serves, logs each request (JSON lines in production), refuses a bad environment and, on
// SIGTERM, finishes in-flight requests and exits; migrate.ts logs the same way; print-schema needs
// no environment at all.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIENT_IP_HEADER, REQUEST_ID_HEADER, SECRET_HEADER } from '@acme/validators/internal-api';
import { describe, expect, it } from 'vitest';

const API = join(import.meta.dirname, '..');
const SCHEMA = join(API, '../../packages/graphql/schema.graphql');
const tsx = (script: string, args: string[], env: Record<string, string>) =>
  [process.execPath, ['--import', 'tsx', script, ...args], { cwd: API, env }] as const;
const base = { PATH: process.env.PATH ?? '' };

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Send a raw HTTP request (fetch cannot send an invalid Host) and read the whole answer. */
function raw(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let answer = '';
    const socket = connect(port, '127.0.0.1', () => socket.write(request));
    socket.on('data', (chunk: Buffer) => (answer += chunk));
    socket.on('end', () => resolve(answer));
    socket.on('error', reject);
  });
}

const SECRET = 'z'.repeat(32);

/** main.ts in production mode on a free port, its output collected (stdout and stderr). */
async function startApi(env: Record<string, string> = {}) {
  const port = await freePort();
  const child = spawn(
    ...tsx('src/main.ts', [], {
      ...base,
      NODE_ENV: 'production',
      PORT: String(port),
      // production mode on IPv4 loopback only: without it, `::` reports 127.0.0.1 as ::ffff:…
      LISTEN_HOST: '127.0.0.1',
      INTERNAL_API_SECRET: SECRET,
      APP_VERSION: 'v-test',
      DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', // never used: the pool is lazy
      ...env,
    }),
  );
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  /** The JSON lines written so far (production logs one object per line). */
  const lines = () =>
    output
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line): unknown => JSON.parse(line))
      .filter((line): line is Record<string, unknown> => line instanceof Object);
  await expect
    .poll(() => lines().map((line) => line.message), { timeout: 15_000 })
    .toContainEqual(expect.stringMatching(/^listening on /));
  const post = (query: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/graphql`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [CLIENT_IP_HEADER]: '203.0.113.7',
        [REQUEST_ID_HEADER]: 'req-1',
        ...headers,
      },
      body: JSON.stringify({ query }),
    });
  return { child, port, exited, lines, output: () => output, post };
}

describe('api entry points', () => {
  it('serves, logs one JSON line per request, then shuts down cleanly on SIGTERM', async () => {
    const api = await startApi();
    try {
      expect((await fetch(`http://127.0.0.1:${api.port}/health`)).status).toBe(200);
      // the forwarded values only with the secret; else the socket's address
      expect((await api.post('{ apiVersion }')).status).toBe(401);
      const res = await api.post('{ apiVersion }', { [SECRET_HEADER]: SECRET });
      expect(await res.json()).toEqual({ data: { apiVersion: 'v-test' } });
      await expect.poll(() => api.lines().length, { timeout: 5_000 }).toBe(3);
      expect(api.lines()).toEqual([
        expect.objectContaining({
          level: 'info',
          app: 'api',
          version: 'v-test',
          // a loopback (or wildcard) address is shown as localhost
          message: `listening on http://localhost:${api.port}/graphql (production)`,
        }),
        expect.objectContaining({
          message: expect.stringMatching(/^401 POST \/graphql \d+ms$/),
          status: 401,
          ip: '127.0.0.1',
        }),
        expect.objectContaining({
          message: expect.stringMatching(/^200 POST \/graphql \d+ms$/),
          level: 'info',
          version: 'v-test',
          status: 200,
          ip: '203.0.113.7',
          requestId: 'req-1',
        }),
      ]);
      expect(api.lines()[1]).not.toHaveProperty('requestId');
      expect(api.output()).not.toContain('/health');
      api.child.kill('SIGTERM');
      expect(await api.exited).toBe(0);
      expect(api.lines().at(-1)).toMatchObject({ message: expect.stringMatching(/^SIGTERM: /) });
    } finally {
      api.child.kill('SIGKILL');
    }
  }, 30_000);

  it('finishes an in-flight request on SIGTERM, closes its connection and exits at once', async () => {
    // a "database" that accepts connections and drops them after a second: the query in flight
    // fails then (a masked error, answered 200), long after SIGTERM
    const sockets = new Set<Socket>();
    const slowDb: Server = createServer((socket) => {
      sockets.add(socket);
      setTimeout(() => socket.destroy(), 1000);
    });
    await new Promise<void>((resolve) => slowDb.listen(0, '127.0.0.1', resolve));
    const address = slowDb.address();
    const dbPort = typeof address === 'object' && address ? address.port : 0;
    const api = await startApi({ DATABASE_URL: `postgres://nobody@127.0.0.1:${dbPort}/none` });
    try {
      const inFlight = api.post('{ notes(first: 1) { edges { cursor } } }', {
        [SECRET_HEADER]: SECRET,
      });
      await expect.poll(() => sockets.size).toBe(1); // the request reached the "database"
      const signalled = performance.now();
      api.child.kill('SIGTERM');
      const res = await inFlight;
      expect(res.status).toBe(200);
      // the client (undici keeps connections alive) is told not to reuse this one
      expect(res.headers.get('connection')).toBe('close');
      expect(await api.exited).toBe(0);
      // not the 8 s force exit: nothing waits on an idle keep-alive connection
      expect(performance.now() - signalled).toBeLessThan(4000);
    } finally {
      api.child.kill('SIGKILL');
      slowDb.close();
    }
  }, 30_000);

  it('answers a request that arrives after SIGTERM, on a connection already open, then closes it', async () => {
    const api = await startApi();
    const socket = connect(api.port, '127.0.0.1');
    try {
      let answer = '';
      socket.on('data', (chunk: Buffer) => (answer += chunk));
      const ended = new Promise((resolve) => socket.once('end', resolve));
      await new Promise((resolve) => socket.once('connect', resolve));
      // the request has begun (so the connection is not idle) when SIGTERM comes
      socket.write('POST /graphql HTTP/1.1\r\nHost: 127.0.0.1\r\n');
      await new Promise((resolve) => setTimeout(resolve, 200));
      api.child.kill('SIGTERM');
      await expect
        .poll(() => api.lines().map((line) => line.message))
        .toContainEqual(expect.stringMatching(/^SIGTERM: /));
      const body = JSON.stringify({ query: '{ apiVersion }' });
      socket.write(
        `content-type: application/json\r\n${SECRET_HEADER}: ${SECRET}\r\n` +
          `content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
      await ended;
      expect(answer).toMatch(/^HTTP\/1\.1 200 /);
      expect(answer).toMatch(/^connection: close\r$/im);
      expect(await api.exited).toBe(0);
    } finally {
      socket.destroy();
      api.child.kill('SIGKILL');
    }
  }, 30_000);

  it('answers a Host that is no URL authority with 400 and a line, not Yoga with a 500', async () => {
    const api = await startApi();
    try {
      const answer = await raw(
        api.port,
        'GET /graphql?query=x HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n',
      );
      expect(answer).toMatch(/^HTTP\/1\.1 400 /);
      expect(answer).not.toContain('TypeError');
      await expect.poll(() => api.lines().length, { timeout: 5_000 }).toBe(2);
      expect(api.lines()[1]).toMatchObject({
        level: 'info',
        message: '400 GET /graphql 0ms',
        status: 400,
        path: '/graphql',
        ip: '127.0.0.1',
      });
      // the server goes on serving
      expect((await fetch(`http://127.0.0.1:${api.port}/health`)).status).toBe(200);
    } finally {
      api.child.kill('SIGKILL');
    }
  }, 30_000);

  it('migrates (nothing left to do on a migrated database) and logs it as one JSON line', () => {
    const res = spawnSync(
      ...tsx('src/migrate.ts', [], {
        ...base,
        NODE_ENV: 'production',
        APP_VERSION: 'v-test',
        // this test file's database: a clone of the migrated template
        DATABASE_URL: process.env.TEST_FILE_DATABASE_URL ?? '',
      }),
    );
    expect(String(res.stderr)).toBe('');
    expect(res.status).toBe(0);
    const lines = String(res.stdout)
      .trim()
      .split('\n')
      .map((line): unknown => JSON.parse(line));
    expect(lines).toEqual([
      expect.objectContaining({
        level: 'info',
        app: 'api',
        version: 'v-test',
        message: expect.stringMatching(/^migrations applied from \S+\/migrations$/),
      }),
    ]);
  }, 30_000);

  it('refuses to start in production without the internal secret', () => {
    const res = spawnSync(
      ...tsx('src/main.ts', [], {
        ...base,
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://127.0.0.1/app',
      }),
    );
    expect(res.status).not.toBe(0);
    expect(String(res.stderr)).toContain('INTERNAL_API_SECRET is required in production');
  }, 30_000);

  it('prints the committed schema with an empty environment (no env, no database)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-schema-'));
    try {
      const out = join(dir, 'schema.graphql');
      const res = spawnSync(...tsx('src/print-schema.ts', [out], base));
      expect(String(res.stderr)).toBe('');
      expect(res.status).toBe(0);
      // a difference means the committed copy is stale: `pnpm nx run api:print-schema`
      expect(readFileSync(out, 'utf8')).toBe(readFileSync(SCHEMA, 'utf8'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('is re-run by Nx when the committed schema changes (a cached pass would hide its drift)', () => {
    const pkg: { nx: { targets: { test: { inputs: unknown[] } } } } = JSON.parse(
      readFileSync(join(API, 'package.json'), 'utf8'),
    );
    expect(pkg.nx.targets.test.inputs).toContain('{workspaceRoot}/packages/graphql/schema.graphql');
  });
});
