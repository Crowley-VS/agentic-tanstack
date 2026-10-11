// The production build run as a process, the way the image runs it (`node .output/server/index.mjs`;
// web:test depends on web:build). On SIGTERM it finishes what is in flight and exits 0, and every
// JSON line stays a line of its own where stdout and stderr are read as one stream, as Railway
// reads them: Nitro's server (srvx) then counts down on stderr on a line it never ends.
import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('../.output/server/index.mjs', import.meta.url));
const SHUTDOWN = 'SIGTERM: finishing in-flight requests, then exiting';

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A stand-in for the API: answers every query after `delayMs`, counting what it received. */
async function fakeApi(delayMs: number) {
  let received = 0;
  const server = createHttpServer((_req, res) => {
    received += 1;
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: { readOnly: false } }));
    }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, port, received: () => received };
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

/**
 * The built server on a free port, in production mode, with stdout and stderr on one file: the
 * order the process wrote them in, as one stream (what a platform that merges them sees).
 */
async function startWeb(api: { server: Server; port: number }) {
  if (!existsSync(ENTRY)) throw new Error(`${ENTRY} is missing: run pnpm nx run web:build`);
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'web-built-server-'));
  const file = join(dir, 'output.log');
  const fd = openSync(file, 'w');
  // only these variables: srvx handles SIGTERM only without CI and TEST (Vitest sets TEST)
  const child: ChildProcess = spawn(process.execPath, [ENTRY], {
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'production',
      PORT: String(port),
      NITRO_HOST: '127.0.0.1',
      APP_VERSION: 'v-test',
      INTERNAL_API_SECRET: 'z'.repeat(32),
      API_HOST: '127.0.0.1',
      API_PORT: String(api.port),
    },
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  cleanup.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => api.server.close(),
    () => child.kill('SIGKILL'),
  );
  const url = `http://127.0.0.1:${port}`;
  // the first request also makes the request middleware listen for SIGTERM
  await expect
    .poll(() => fetch(`${url}/api/health`).then((res) => res.status, String), { timeout: 15_000 })
    .toBe(200);
  /** The output's lines, split as a platform splits the merged stream. */
  const lines = () => readFileSync(file, 'utf8').split('\n');
  /** The lines that parse as JSON: the web server's records. */
  const records = () =>
    lines().flatMap((line): Record<string, unknown>[] => {
      if (!line.startsWith('{')) return [];
      const parsed: unknown = JSON.parse(line);
      return parsed instanceof Object ? [parsed as Record<string, unknown>] : [];
    });
  /** Lines that hold a record but are not one: a record joined to srvx's open line. */
  const broken = () => lines().filter((line) => line.includes('{"time"') && !line.startsWith('{'));
  return { child, url, exited, lines, records, broken };
}

describe('the built server on SIGTERM', () => {
  it("writes its shutdown record on a line of its own, ahead of srvx's countdown, and exits 0", async () => {
    const web = await startWeb(await fakeApi(0));
    web.child.kill('SIGTERM');
    expect(await web.exited).toBe(0);
    expect(web.records()).toContainEqual(
      expect.objectContaining({ level: 'info', app: 'web', version: 'v-test', message: SHUTDOWN }),
    );
    expect(web.broken()).toEqual([]);
    // srvx did count down (so this test saw the open line), after the record
    const countdown = web.lines().findIndex((line) => line.includes('Stopping server gracefully'));
    const record = web.lines().findIndex((line) => line.includes(SHUTDOWN));
    expect(countdown).toBeGreaterThan(record);
    expect(web.lines().join('\n')).toContain('Server closed successfully.');
  }, 30_000);

  it('finishes a request in flight with connection: close, its record on a line of its own', async () => {
    const api = await fakeApi(1500);
    const web = await startWeb(api);
    const inFlight = fetch(`${web.url}/api/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ readOnly }' }),
    });
    await expect.poll(() => api.received()).toBe(1); // the BFF is waiting for the API
    const signalled = performance.now();
    web.child.kill('SIGTERM');
    const res = await inFlight;
    expect(res.status).toBe(200);
    expect(res.headers.get('connection')).toBe('close');
    expect(await web.exited).toBe(0);
    // as it finishes, not at srvx's 5 s timeout (SERVER_SHUTDOWN_TIMEOUT)
    expect(performance.now() - signalled).toBeLessThan(4000);
    expect(web.broken()).toEqual([]);
    expect(web.records()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: SHUTDOWN }),
        expect.objectContaining({
          level: 'info',
          app: 'web',
          version: 'v-test',
          message: expect.stringMatching(/^200 POST \/api\/graphql \d+ms$/),
        }),
      ]),
    );
  }, 30_000);
});
