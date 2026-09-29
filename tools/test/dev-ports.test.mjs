import { describe, expect, it } from 'vitest';
import { computePorts, pathHash, toEnv } from '../dev-ports.mjs';

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

  it('sanitizes odd directory names into a compose-safe slug', () => {
    expect(computePorts({ root: '/w/My App!', primary: true }).composeProject).toBe('my-app');
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
