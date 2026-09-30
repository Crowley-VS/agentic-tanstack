import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assignBlock,
  computePorts,
  detectCheckout,
  pathHash,
  preferredBlock,
  toEnv,
  worktreeBlock,
} from '../dev-ports.mjs';
import { commitAll, makeRepo, tempDir } from './helpers.mjs';

const DEV_PORTS = resolve(import.meta.dirname, '../dev-ports.mjs');
/**
 * The test's environment without the overrides dev-ports honours: a developer's exported WEB_PORT
 * (see .env.example), or a run under `dev-ports --exec`, must not change what the CLI tests see.
 */
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) =>
      ![
        'WEB_PORT',
        'API_PORT',
        'DB_PORT',
        'WEB_E2E_PORT',
        'API_E2E_PORT',
        'COMPOSE_PROJECT_NAME',
      ].includes(k),
  ),
);
/** Run the CLI in `cwd` (a primary checkout when it is no git repository). */
const cli = (args, { cwd, env = {} } = {}) =>
  spawnSync(process.execPath, [DEV_PORTS, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...CLEAN_ENV, ...env },
  });
const worktreeNames = Array.from(
  { length: 60 },
  (_, i) => `/home/u/app/.claude/worktrees/agent-${i}`,
);

describe('computePorts', () => {
  it('uses fixed, memorable ports in the primary checkout', () => {
    const info = computePorts({ root: '/work/my-app', primary: true });
    expect(info.ports).toEqual({ web: 3000, api: 4000, db: 5432, webE2e: 3100, apiE2e: 4100 });
    expect(info.composeProject).toBe('my-app');
    expect(info.urls.web).toBe('http://localhost:3000');
    expect(info.databaseUrls.dev).toBe('postgres://postgres:postgres@127.0.0.1:5432/app');
  });

  it('gives linked worktrees a deterministic block inside 20000-59999', () => {
    const a = computePorts({ root: '/work/my-app/.claude/worktrees/a', primary: false });
    const again = computePorts({ root: '/work/my-app/.claude/worktrees/a', primary: false });
    const b = computePorts({ root: '/work/my-app/.claude/worktrees/b', primary: false });
    expect(a).toEqual(again);
    expect(a.ports.web).toBeGreaterThanOrEqual(20000);
    expect(a.ports.apiE2e).toBeLessThan(60000);
    expect(a.ports.api).toBe(a.ports.web + 1);
    expect(a.composeProject).toBe(`a-${pathHash('/work/my-app/.claude/worktrees/a')}`);
    expect(b.composeProject).not.toBe(a.composeProject);
  });

  it('lets environment variables override ports and the compose project', () => {
    const info = computePorts(
      { root: '/work/my-app', primary: true },
      { WEB_PORT: '8080', DB_PORT: '6543', COMPOSE_PROJECT_NAME: 'ci' },
    );
    expect(info.ports.web).toBe(8080);
    expect(info.ports.db).toBe(6543);
    expect(info.composeProject).toBe('ci');
    expect(info.databaseUrls.e2e).toBe('postgres://postgres:postgres@127.0.0.1:6543/e2e');
  });

  it('gives every worktree its own database names, even on one shared Postgres server', () => {
    const shared = { DB_PORT: '5432' }; // e.g. an override pointing every worktree at one server
    const primary = computePorts({ root: '/work/my-app', primary: true }, shared);
    const roots = ['/work/my-app/.claude/worktrees/a', '/work/my-app/.claude/worktrees/b'];
    const [a, b] = roots.map((root) => computePorts({ root, primary: false }, shared));
    expect(a?.databaseUrls.dev).toBe(
      `postgres://postgres:postgres@127.0.0.1:5432/app_${pathHash(roots[0] ?? '')}`,
    );
    expect(a?.databaseUrls.e2e).toMatch(/\/e2e_[0-9a-f]{8}$/);
    const urls = [primary, a, b].flatMap((i) => [i?.databaseUrls.dev, i?.databaseUrls.e2e]);
    expect(new Set(urls).size).toBe(urls.length);
    // the maintenance database the test harness creates its own databases from
    expect(a?.databaseUrls.test).toBe(primary.databaseUrls.test);
  });

  it('sanitizes odd directory names into a compose-safe slug', () => {
    expect(computePorts({ root: '/w/My App!', primary: true }).composeProject).toBe('my-app');
  });
});

describe('worktree port blocks', () => {
  it('gives every worktree of a repository its own block, even when their hashes collide', () => {
    const preferred = worktreeNames.map(preferredBlock);
    expect(new Set(preferred).size).toBeLessThan(preferred.length); // the collisions are real
    const registry = {};
    for (const root of worktreeNames) registry[root] = assignBlock(registry, root);
    const blocks = Object.values(registry);
    expect(new Set(blocks).size).toBe(worktreeNames.length);
    const ports = worktreeNames.map(
      (root) => computePorts({ root, primary: false, block: registry[root] }).ports.web,
    );
    expect(new Set(ports).size).toBe(worktreeNames.length);
    expect(Math.min(...ports)).toBeGreaterThanOrEqual(20000);
    expect(Math.max(...ports) + 11).toBeLessThan(60000);
  });

  it('keeps a recorded block and probes past a taken preferred one', () => {
    const root = '/w/.claude/worktrees/x';
    const taken = preferredBlock(root);
    expect(assignBlock({ '/other': taken }, root)).toBe((taken + 1) % 400);
    expect(assignBlock({ [root]: 7 }, root)).toBe(7);
  });

  it('records blocks in the registry and frees those of removed worktrees', () => {
    const commonDir = tempDir();
    const a = join(tempDir(), 'a');
    const b = join(tempDir(), 'b');
    mkdirSync(a);
    mkdirSync(b);
    const blockA = worktreeBlock(a, commonDir);
    const blockB = worktreeBlock(b, commonDir);
    expect(blockA).not.toBe(blockB);
    expect(worktreeBlock(a, commonDir)).toBe(blockA); // stable
    const registry = JSON.parse(readFileSync(join(commonDir, 'dev-ports.json'), 'utf8'));
    expect(registry).toEqual({ [a]: blockA, [b]: blockB });
    // `a` is gone: its entry is dropped the next time anyone looks
    worktreeBlock(b, commonDir, { exists: (p) => p !== a });
    expect(JSON.parse(readFileSync(join(commonDir, 'dev-ports.json'), 'utf8'))).toEqual({
      [b]: blockB,
    });
    expect(existsSync(join(commonDir, 'dev-ports.json.lock'))).toBe(false);
  });

  it('falls back to the preferred block when the registry cannot be written', () => {
    expect(worktreeBlock('/w/x', join(tempDir(), 'missing', 'dir'))).toBeUndefined();
  });
});

describe('detectCheckout', () => {
  it('tells the primary checkout from a linked worktree, from any subdirectory', () => {
    const root = realpathSync(makeRepo({ 'sub/dir/file.txt': 'x' }));
    commitAll(root);
    const wt = join(realpathSync(tempDir()), 'wt');
    execFileSync('git', ['worktree', 'add', '-q', '--detach', wt], { cwd: root });

    const primary = detectCheckout(join(root, 'sub/dir'));
    expect(primary).toMatchObject({ root, primary: true });
    const linked = detectCheckout(join(wt, 'sub'));
    expect(linked).toMatchObject({ root: wt, primary: false });
    expect(linked.commonDir).toBe(primary.commonDir);
  });

  it('gives two real worktrees whose paths hash to the same block distinct ports through the CLI', () => {
    const root = makeRepo({ 'a.txt': 'x' });
    commitAll(root);
    // Two worktree paths with the same preferred block: without the registry they would share ports.
    const parent = realpathSync(tempDir());
    const byBlock = new Map();
    let pair;
    for (let i = 0; !pair; i++) {
      const wt = join(parent, `wt-${i}`);
      const other = byBlock.get(preferredBlock(wt));
      if (other) pair = [other, wt];
      else byBlock.set(preferredBlock(wt), wt);
    }
    const webPorts = pair.map((wt) => {
      execFileSync('git', ['worktree', 'add', '-q', '--detach', wt], { cwd: root });
      return JSON.parse(cli(['--json'], { cwd: wt }).stdout).ports.web;
    });
    expect(webPorts[0]).not.toBe(webPorts[1]);
    // ...because the CLI recorded each worktree's block in the registry both worktrees share.
    const registry = JSON.parse(readFileSync(join(root, '.git', 'dev-ports.json'), 'utf8'));
    expect(registry).toEqual({
      [pair[0]]: (webPorts[0] - 20000) / 100,
      [pair[1]]: (webPorts[1] - 20000) / 100,
    });
  });
});

describe('CLI modes', () => {
  // outside any git repository: the primary checkout's fixed ports
  it('--get prints one value and fails on an unknown key', () => {
    const cwd = tempDir();
    expect(cli(['--get', 'web'], { cwd }).stdout).toBe('http://localhost:3000\n');
    expect(cli(['--get', 'db'], { cwd }).stdout).toBe('5432\n');
    const unknown = cli(['--get', 'nope'], { cwd });
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('dev-ports: unknown key "nope"');
  });

  it('--env prints KEY=VALUE lines, overrides included', () => {
    const cwd = tempDir();
    const lines = cli(['--env'], { cwd, env: { API_PORT: '4999' } }).stdout.split('\n');
    expect(lines).toEqual(expect.arrayContaining(['WEB_PORT=3000', 'API_PORT=4999']));
  });

  it('--exec runs the command with the env (existing env wins) and passes its exit code on', () => {
    const cwd = tempDir();
    const port = [process.execPath, '-e', 'console.log(process.env.WEB_PORT)'];
    expect(cli(['--exec', '--', ...port], { cwd }).stdout).toBe('3000\n');
    expect(cli(['--exec', '--', ...port], { cwd, env: { WEB_PORT: '9999' } }).stdout).toBe(
      '9999\n',
    );
    expect(cli(['--exec', '--', process.execPath, '-e', 'process.exit(3)'], { cwd }).status).toBe(
      3,
    );
  });

  it('--exec reports a command it cannot start, with exit code 127', () => {
    const res = cli(['--exec', '--', 'no-such-command-for-dev-ports'], { cwd: tempDir() });
    expect(res.status).toBe(127);
    expect(res.stderr).toContain('dev-ports: could not start no-such-command-for-dev-ports:');
    expect(res.stderr).not.toContain('    at ');
  });
});

describe('toEnv', () => {
  it('exposes every port and database URL as strings', () => {
    const env = toEnv(computePorts({ root: '/work/my-app', primary: true }));
    expect(env).toMatchObject({
      WEB_PORT: '3000',
      API_PORT: '4000',
      DB_PORT: '5432',
      API_HOST: 'localhost',
      COMPOSE_PROJECT_NAME: 'my-app',
    });
    expect(Object.values(env).every((v) => typeof v === 'string')).toBe(true);
  });
});
