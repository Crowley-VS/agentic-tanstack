// The web project's build and serve targets (package.json), run as the shell runs them with fakes
// on PATH: a fake `node` or `vite` prints the environment the real one would get.
// web:serve runs the production build on a developer's machine, next to api:dev, which serves
// introspection and ignores the secret: on every interface, the BFF would relay anyone on the
// network to it. Nitro listens on every interface unless NITRO_HOST (or HOST) says otherwise.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type Target = { command: string; options?: { env?: Record<string, string> } };
const { targets }: { targets: Record<string, Target> } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).nx;

const target = (name: string): Target => {
  const found = targets[name];
  if (!found) throw new Error(`apps/web/package.json has no ${name} target`);
  return found;
};

/** The shell script a serve target runs, after dev-ports has set this checkout's ports. */
const serveScript = (name: string) => /sh -c '([^']*)'/.exec(target(name).command)?.[1] ?? '';

/** Run `script` with `sh -c`, fake `bins` ({ name: shell body }) first on PATH, and only `env`. */
function run(script: string, bins: Record<string, string>, env: Record<string, string>): string {
  const bin = mkdtempSync(join(tmpdir(), 'web-targets-'));
  try {
    for (const [name, body] of Object.entries(bins)) {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    return execFileSync('sh', ['-c', script], {
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, ...env },
      encoding: 'utf8',
    }).trim();
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

describe('web:serve', () => {
  const serverHost = (env: Record<string, string>) =>
    run(serveScript('serve'), { node: 'echo "$NITRO_HOST"' }, { WEB_PORT: '1', ...env });

  it('runs the built server', () => {
    expect(serveScript('serve')).toContain('exec node .output/server/index.mjs');
  });

  it('listens on this machine only, unless NITRO_HOST says otherwise', () => {
    expect(serverHost({})).toBe('127.0.0.1');
    expect(serverHost({ NITRO_HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });
});

describe('web:build', () => {
  it('builds for production even when the shell or .env says NODE_ENV=development', () => {
    // a dev-mode build calls jsxDEV, which the production server lacks: every SSR page fails
    const fakes = { vite: 'echo "vite $*: $NODE_ENV"', node: 'true' };
    expect(run(target('build').command, fakes, { NODE_ENV: 'development' })).toBe(
      'vite build: production',
    );
  });
});

describe('web:serve-e2e', () => {
  it('runs the built server on the e2e port, against the e2e API', () => {
    const fakes = { node: 'echo "$* on $PORT, API on $API_PORT"' };
    expect(
      run(serveScript('serve-e2e'), fakes, { WEB_E2E_PORT: '3100', API_E2E_PORT: '4100' }),
    ).toBe('.output/server/index.mjs on 3100, API on 4100');
  });

  it('runs in production mode on this machine only, without the write rate limit', () => {
    // Nx applies options.env over the shell and .env, so these values always win
    expect(target('serve-e2e').options?.env).toMatchObject({
      NODE_ENV: 'production',
      NITRO_HOST: '127.0.0.1',
      API_HOST: '127.0.0.1',
      E2E: '1',
    });
  });
});
