// The real entry points, run as processes the way the platform runs them (from source, via tsx):
// main.ts serves, refuses a bad environment and exits cleanly on SIGTERM; print-schema needs no
// environment at all.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('serves, then shuts down cleanly on SIGTERM', async () => {
    const port = await freePort();
    const child = spawn(
      ...tsx('src/main.ts', [], {
        ...base,
        NODE_ENV: 'production',
        PORT: String(port),
        INTERNAL_API_SECRET: 'z'.repeat(32),
        DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', // never used: the pool is lazy
      }),
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk));
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    try {
      await expect.poll(() => output, { timeout: 15_000 }).toContain('[api] listening');
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
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
});
