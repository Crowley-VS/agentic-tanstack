import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findLeaks, MARKERS } from './check-client-bundle.mjs';

/** What the check must catch, written out here: deleting one from MARKERS fails a test. */
const SERVER_ONLY = ['INTERNAL_API_SECRET', 'x-internal-secret', 'API_HOST'];
const SECRET = 'leaked-secret-value-0123456789abcdef';

const SCRIPT = fileURLToPath(new URL('./check-client-bundle.mjs', import.meta.url));
const dirs = [];

/** A fake .output/public with the given files. */
function bundle(files) {
  const dir = mkdtempSync(join(tmpdir(), 'web-client-bundle-'));
  dirs.push(dir);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}
const run = (args, env = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('check-client-bundle', () => {
  const clean = {
    'assets/index-B8Ro9W1U.js': 'fetch("/api/graphql",{method:"POST"});',
    'assets/routes-BSE7IUIN.js': 'import("react-dom/server.browser");',
  };

  it('passes a bundle without server-only code', () => {
    const dir = bundle(clean);
    expect(findLeaks(dir)).toEqual([]);
    const res = run([dir], { INTERNAL_API_SECRET: SECRET });
    expect(res.status, res.stderr).toBe(0);
  });

  it('checks every server-only name', () => {
    expect(MARKERS).toEqual(expect.arrayContaining(SERVER_ONLY));
  });

  it.each(SERVER_ONLY)('fails the build when a client file contains %s', (marker) => {
    const dir = bundle({
      ...clean,
      'assets/deep/chunk-1.js': `const k=${JSON.stringify(marker)};`,
    });
    expect(findLeaks(dir)).toEqual([`assets/deep/chunk-1.js: ${marker}`]);
    const res = run([dir]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`assets/deep/chunk-1.js: ${marker}`);
  });

  it("fails the build when a client file contains the secret's value, without printing it", () => {
    // e.g. inlined by a `define` or a VITE_ variable: no variable name is left to find
    const dir = bundle({ ...clean, 'assets/routes-x.js': `const k=${JSON.stringify(SECRET)};` });
    expect(findLeaks(dir, { INTERNAL_API_SECRET: SECRET })).toEqual([
      'assets/routes-x.js: the value of INTERNAL_API_SECRET',
    ]);
    const res = run([dir], { INTERNAL_API_SECRET: SECRET });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('assets/routes-x.js: the value of INTERNAL_API_SECRET');
    expect(res.stderr + res.stdout).not.toContain(SECRET);
    // without a secret in the build's environment there is no value to look for
    expect(run([dir]).status).toBe(0);
  });

  it('fails on a *.server module, by chunk name or by source path', () => {
    const dir = bundle({
      ...clean,
      'assets/env.server-Ab12_x.js': 'export{}',
      'assets/index-B8Ro9W1U.js.map': '{"sources":["../../src/server/internal-api.server.ts"]}',
    });
    expect(findLeaks(dir).toSorted()).toEqual([
      'assets/env.server-Ab12_x.js: named after a *.server module',
      'assets/index-B8Ro9W1U.js.map: internal-api.server.ts',
    ]);
  });

  it('fails when there is no bundle to check', () => {
    const res = run([join(bundle({}), 'missing')]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('does not exist');
  });
});
