// Projects tagged needs-db test against this checkout's one Postgres. Their Vitest global setups
// each start it when it is down, so on a cold machine (every CI runner) parallel test tasks raced
// `docker compose up` for the same compose project: Nx starts it first, once, with a single
// db:db-up task that every needs-db test task depends on.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { nodeBin } from '../lib/bin.mjs';

const REPO = resolve(import.meta.dirname, '../..');

it('starts the database once, with db:db-up, before the tests of every needs-db project', () => {
  const [cmd = '', ...pre] = nodeBin(REPO, 'nx') ?? [];
  expect(cmd, 'nx is not installed: run `pnpm install`').not.toBe('');
  const nx = (...args) => execFileSync(cmd, [...pre, ...args], { cwd: REPO, encoding: 'utf8' });
  const projects = JSON.parse(
    nx('show', 'projects', '--projects', 'tag:needs-db', '--with-target', 'test', '--json'),
  );
  expect(projects).toEqual(expect.arrayContaining(['db', 'core']));
  const { tasks } = JSON.parse(
    nx('run-many', '-t', 'test', '-p', projects.join(','), '--graph=stdout'),
  );
  for (const p of projects) expect(tasks.dependencies[`${p}:test`], p).toContain('db:db-up');
}, 60_000);
