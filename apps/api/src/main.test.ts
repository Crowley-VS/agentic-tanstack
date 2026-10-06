// The real entry points, run as processes the way the platform runs them (from source, via tsx):
// main.ts serves, logs each request, refuses a bad environment and exits cleanly on SIGTERM;
// print-schema needs no environment at all.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
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

describe('api entry points', () => {
  it('serves, logs each request, then shuts down cleanly on SIGTERM', async () => {
    const port = await freePort();
    const secret = 'z'.repeat(32);
    const child = spawn(
      ...tsx('src/main.ts', [], {
        ...base,
        NODE_ENV: 'production',
        PORT: String(port),
        // production mode on IPv4 loopback only: without it, `::` reports 127.0.0.1 as ::ffff:…
        LISTEN_HOST: '127.0.0.1',
        INTERNAL_API_SECRET: secret,
        DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', // never used: the pool is lazy
      }),
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk));
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    const post = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${port}/graphql`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [CLIENT_IP_HEADER]: '203.0.113.7',
          [REQUEST_ID_HEADER]: 'req-1',
          ...headers,
        },
        body: JSON.stringify({ query: '{ apiVersion }' }),
      });
    try {
      await expect.poll(() => output, { timeout: 15_000 }).toContain('[api] listening');
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
      // the forwarded values only with the secret; else the socket's address
      expect((await post({})).status).toBe(401);
      expect((await post({ [SECRET_HEADER]: secret })).status).toBe(200);
      await expect
        .poll(() => output, { timeout: 5_000 })
        .toMatch(/^\[api\] 200 POST \/graphql \d+ms ip=203\.0\.113\.7 id=req-1$/m);
      expect(output).toMatch(/^\[api\] 401 POST \/graphql \d+ms ip=127\.0\.0\.1 id=-$/m);
      expect(output).not.toContain('/health');
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(output).toContain('[api] SIGTERM: shutting down');
    } finally {
      child.kill('SIGKILL');
    }
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
