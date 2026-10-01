// Claude Code sessions (.claude/settings.json "env") keep Nx's and Node's per-checkout temp files
// off /tmp: docs/local-resources.md has the why and the measurements.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeBin } from '../lib/bin.mjs';
import { tempDir } from './helpers.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const settings = JSON.parse(readFileSync(join(REPO, '.claude/settings.json'), 'utf8'));

describe('agent sessions', () => {
  it('set the variables that keep temp files off /tmp', () => {
    expect(settings.env).toMatchObject({ NX_USE_LOCAL: 'true', NODE_DISABLE_COMPILE_CACHE: '1' });
  });

  it('NX_USE_LOCAL still stops every nx@latest install of the installed Nx daemon', () => {
    // the daemon's handlers call getLatestNxTmpPath() only when NX_USE_LOCAL is not 'true'
    const server = join(
      dirname(createRequire(join(REPO, 'package.json')).resolve('nx/package.json')),
      'dist/src/daemon/server',
    );
    const callers = readdirSync(server)
      .filter((f) => f.endsWith('.js') && f !== 'latest-nx.js')
      .map((f) => [f, readFileSync(join(server, f), 'utf8')])
      .filter(([, js]) => js.includes('getLatestNxTmpPath)('));
    expect(callers.map(([f]) => f).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'handle-configure-ai-agents.js',
      'nx-console-operations.js',
    ]);
    for (const [f, js] of callers) expect(js, f).toContain("process.env.NX_USE_LOCAL === 'true'");
  });

  it('NODE_DISABLE_COMPILE_CACHE stops ESLint writing a compile cache to the temp dir', () => {
    const eslint = nodeBin(REPO, 'eslint');
    expect(eslint, 'eslint is not installed: run `pnpm install`').toBeDefined();
    const [cmd = '', ...args] = eslint ?? [];
    const run = (env) => {
      const tmp = tempDir();
      const base = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
      delete base.NODE_COMPILE_CACHE; // (a session running these tests may set either)
      delete base.NODE_DISABLE_COMPILE_CACHE;
      const res = spawnSync(cmd, [...args, '--version'], { cwd: REPO, env: { ...base, ...env } });
      expect(res.status).toBe(0);
      return existsSync(join(tmp, 'node-compile-cache'));
    };
    expect(run({})).toBe(true); // what the bin does by default
    expect(run({ NODE_DISABLE_COMPILE_CACHE: settings.env.NODE_DISABLE_COMPILE_CACHE })).toBe(
      false,
    );
  });
});
