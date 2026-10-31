import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
        'DB_STUDIO_PORT',
        'WEB_E2E_PORT',
        'API_E2E_PORT',
        'STACK_PORT',
        'COMPOSE_PROJECT_NAME',
        'STACK_PROJECT',
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
    expect(info.ports).toEqual({
      web: 3000,
      api: 4000,
      db: 5432,
      studio: 4983, // drizzle-kit studio's own default
      webE2e: 3100,
      apiE2e: 4100,
      stack: 3200,
    });
    expect(info.composeProject).toBe('my-app');
    expect(info.stackProject).toBe('my-app-stack');
    expect(info.urls.web).toBe('http://localhost:3000');
    expect(info.urls.stack).toBe('http://127.0.0.1:3200');
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
    expect(a.ports.studio).toBe(a.ports.web + 3); // never drizzle-kit's default 4983
    expect(a.ports.stack).toBe(a.ports.web + 20);
    expect(a.ports.stack).toBeLessThan(a.ports.web + 100); // inside the worktree's block
    expect(a.composeProject).toBe(`a-${pathHash('/work/my-app/.claude/worktrees/a')}`);
    expect(a.ownsComposeProject).toBe(true);
    expect(b.composeProject).not.toBe(a.composeProject);
  });

  it('lets environment variables override ports and the compose project', () => {
    const info = computePorts(
      { root: '/work/my-app', primary: true },
      { WEB_PORT: '8080', DB_PORT: '6543', DB_STUDIO_PORT: '5983', COMPOSE_PROJECT_NAME: 'ci' },
    );
    expect(info.ports.web).toBe(8080);
    expect(info.ports.db).toBe(6543);
    expect(info.ports.studio).toBe(5983);
    expect(info.composeProject).toBe('ci');
    expect(info.stackProject).toBe('ci-stack');
    expect(info.ownsComposeProject).toBe(false); // db-up labels nothing as this checkout's
    expect(info.ownsStackProject).toBe(false); // nor does stack-down remove its stack
    expect(info.databaseUrls.e2e).toBe('postgres://postgres:postgres@127.0.0.1:6543/e2e');
  });

  it("owns only the checkout's own stack project, or in CI the one STACK_PROJECT names", () => {
    const checkout = { root: '/work/my-app', primary: true };
    const owns = (env) => computePorts(checkout, env).ownsStackProject;
    expect(owns({})).toBe(true);
    expect(owns({ STACK_PROJECT: 'my-app-stack' })).toBe(true);
    expect(owns({ COMPOSE_PROJECT_NAME: 'my-app' })).toBe(true);
    // named elsewhere: maybe another checkout's stack, which `pnpm teardown` here must not remove
    expect(computePorts(checkout, { STACK_PROJECT: 'theirs' }).stackProject).toBe('theirs');
    expect(owns({ STACK_PROJECT: 'theirs' })).toBe(false);
    expect(owns({ COMPOSE_PROJECT_NAME: 'shared' })).toBe(false);
    // a CI runner holds one checkout: the project its workflow names is the run's own. Not the
    // placeholder project's name: bootstrap renames it, to `my-app-stack` with `--name my-app`
    // (the README's), and this checkout's own stack is already owned
    expect(owns({ CI: 'true', STACK_PROJECT: 'ci-stack' })).toBe(true);
    expect(owns({ CI: 'false', STACK_PROJECT: 'ci-stack' })).toBe(false);
    expect(owns({ CI: '0', STACK_PROJECT: 'ci-stack' })).toBe(false);
    expect(owns({ CI: 'true', COMPOSE_PROJECT_NAME: 'shared' })).toBe(false);
    const worktree = { root: '/work/my-app/.claude/worktrees/a', primary: false };
    const own = computePorts(worktree);
    expect(own.stackProject).toBe(`${own.composeProject}-stack`);
    expect(own.ownsStackProject).toBe(true);
    // the primary checkout's stack, named from a worktree, is not the worktree's
    expect(computePorts(worktree, { STACK_PROJECT: 'my-app-stack' }).ownsStackProject).toBe(false);
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

  it('spells the common dir the same from every checkout, a symlinked path included (--json)', () => {
    const root = realpathSync(makeRepo({ 'a.txt': 'x' }));
    commitAll(root);
    const wt = join(realpathSync(tempDir()), 'wt');
    execFileSync('git', ['worktree', 'add', '-q', '--detach', wt], { cwd: root });
    const link = join(realpathSync(tempDir()), 'link');
    symlinkSync(root, link);
    for (const cwd of [root, wt])
      expect(JSON.parse(cli(['--json'], { cwd }).stdout).commonDir, cwd).toBe(join(root, '.git'));
    // a caller passing a path through a symlink gets the real one too
    expect(detectCheckout(link)).toMatchObject({
      primary: true,
      commonDir: join(root, '.git'),
    });
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
    expect(lines).toEqual(
      expect.arrayContaining(['WEB_PORT=3000', 'API_PORT=4999', 'DB_STUDIO_PORT=4983']),
    );
  });

  // Two primary checkouts on one machine (two projects made from the template) share the fixed
  // ports: the second keeps its own in its .env.local, which Nx also loads into every task (and
  // infers the e2e targets again when it changes: e2e-wiring.test.mjs).
  it('reads the port variables in .env.local at the checkout root; the environment wins, a bad port fails', () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, '.env.local'),
      '# 3000 and 5432 are taken\nWEB_PORT=3010\nDB_PORT = "5442"\nOTHER_SETTING=not-a-port\n',
    );
    expect(cli(['--get', 'web'], { cwd }).stdout).toBe('http://localhost:3010\n');
    expect(cli(['--get', 'db'], { cwd }).stdout).toBe('5442\n');
    expect(cli(['--get', 'web'], { cwd, env: { WEB_PORT: '3020' } }).stdout).toBe(
      'http://localhost:3020\n',
    );
    writeFileSync(join(cwd, '.env.local'), 'WEB_PORT=web\n');
    const bad = cli(['--get', 'web'], { cwd });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('dev-ports: .env.local sets WEB_PORT="web", which is no port');
    expect(bad.stderr).not.toContain('    at ');
  });

  it('--print lists the URLs, Drizzle Studio on its own port included', () => {
    const out = cli(['--print'], { cwd: tempDir(), env: { DB_STUDIO_PORT: '5983' } }).stdout;
    expect(out).toContain('http://localhost:3000');
    expect(out).toContain('https://local.drizzle.studio?port=5983');
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
      DB_STUDIO_PORT: '4983',
      STACK_PORT: '3200',
      API_HOST: 'localhost',
      COMPOSE_PROJECT_NAME: 'my-app',
      STACK_PROJECT: 'my-app-stack',
    });
    expect(Object.values(env).every((v) => typeof v === 'string')).toBe(true);
  });

  it("labels the stack with this checkout only when it is the checkout's own", () => {
    const checkout = { root: '/work/my-app', primary: true, commonDir: '/work/my-app/.git' };
    expect(toEnv(computePorts(checkout))).toMatchObject({
      DEV_CHECKOUT_ROOT: '/work/my-app',
      DEV_CHECKOUT_GIT_COMMON_DIR: '/work/my-app/.git',
    });
    // a project STACK_PROJECT or COMPOSE_PROJECT_NAME names may be another checkout's: never
    // pruned with this one
    for (const env of [{ COMPOSE_PROJECT_NAME: 'shared' }, { STACK_PROJECT: 'theirs' }])
      expect(toEnv(computePorts(checkout, env))).toMatchObject({
        DEV_CHECKOUT_ROOT: '',
        DEV_CHECKOUT_GIT_COMMON_DIR: '',
      });
  });
});
