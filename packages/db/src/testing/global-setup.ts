// Vitest globalSetup for projects whose tests touch the database. Starts this checkout's Postgres
// (fast no-op when running; when Nx runs several such projects at once, one process starts it and
// the others wait for it, scripts/db-up.mjs), (re)builds this checkout's template database
// (`test_template`, or `test_template_<hash>` in a worktree) only when the migrations changed, and
// sweeps clones left behind by crashed runs. Each test FILE then gets its own clone (see
// setup-file.ts): ~10 ms, fully isolated, parallel-safe.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
// @ts-expect-error plain .mjs script shared with the db targets
import { alive, dbUp } from '../../scripts/db-up.mjs';
import { MIGRATIONS_DIR, runMigrations } from '../migrate';

declare module 'vitest' {
  export interface ProvidedContext {
    testDb: { adminUrl: string; template: string; runId: number };
  }
}

function hashDir(dir: string): string {
  const hash = createHash('sha256');
  for (const f of (readdirSync(dir, { recursive: true }) as string[]).toSorted()) {
    const p = join(dir, f);
    if (statSync(p).isFile()) hash.update(f).update('\0').update(readFileSync(p)).update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

const withDb = (url: string, db: string) =>
  Object.assign(new URL(url), { pathname: `/${db}` }).toString();

export default async function setup(project: TestProject) {
  // per checkout, so worktrees pointed at one server never rebuild each other's template
  const { adminUrl, testTemplate: template } = await dbUp();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  // serialize concurrent test runs against the same server (nx run-many, two terminals)
  await admin.query('select pg_advisory_lock(hashtext($1))', [template]);
  try {
    const hash = hashDir(MIGRATIONS_DIR);
    const { rows } = await admin.query(
      `select shobj_description(oid, 'pg_database') as hash from pg_database where datname = $1`,
      [template],
    );
    if (rows[0]?.hash !== hash) {
      if (rows.length) {
        await admin.query(`alter database ${template} is_template false allow_connections true`);
        await admin.query(`drop database ${template} with (force)`);
      }
      await admin.query(`create database ${template}`);
      await runMigrations(withDb(adminUrl, template)); // closes its pool: a template needs 0 connections
      await admin.query(`alter database ${template} with is_template true allow_connections false`);
      await admin.query(`comment on database ${template} is '${hash}'`); // last: a crash means rebuild
    }
    // clones are named t_<vitest pid>_…: drop those of runs that are gone
    const stale = await admin.query(`select datname from pg_database where datname ~ '^t_[0-9]+_'`);
    for (const { datname } of stale.rows as { datname: string }[])
      if (!alive(Number(datname.split('_')[1])))
        await admin.query(`drop database if exists "${datname}" with (force)`);
  } finally {
    await admin.query('select pg_advisory_unlock(hashtext($1))', [template]);
  }

  project.provide('testDb', { adminUrl, template, runId: process.pid });

  return async () => {
    const { rows } = await admin.query(`select datname from pg_database where datname like $1`, [
      `t\\_${process.pid}\\_%`,
    ]);
    for (const { datname } of rows as { datname: string }[])
      await admin.query(`drop database if exists "${datname}" with (force)`);
    await admin.end();
  };
}
