// ensureDatabase() on a database of its own (not the test file's clone): created once and then
// kept; `fresh` (db:db-seed-e2e) drops it first, even while a leftover e2e server is connected.
// runMigrations() on another one, from migrations folders the tests write: what the db-migration
// skill's rule for an index on a large table rests on.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDatabase, runMigrations } from './migrate';

// named after this file's clone (t_<run>_…), so the global setup drops them if afterAll never runs
const clone = new URL(process.env.TEST_FILE_DATABASE_URL ?? '');
const name = `${clone.pathname.slice(1)}_ensure`;
const url = Object.assign(new URL(clone), { pathname: `/${name}` }).toString();
const migratedName = `${clone.pathname.slice(1)}_migrate`;
const migratedUrl = Object.assign(new URL(clone), { pathname: `/${migratedName}` }).toString();
const adminUrl = Object.assign(new URL(clone), { pathname: '/postgres' }).toString();
const admin = new pg.Client({ connectionString: adminUrl });
const tmp = mkdtempSync(join(tmpdir(), 'migrate-test-'));

beforeAll(() => admin.connect());
afterAll(async () => {
  rmSync(tmp, { recursive: true, force: true });
  for (const db of [name, migratedName])
    await admin.query(`drop database if exists "${db}" with (force)`);
  await admin.end();
});

async function tables(dbUrl = url): Promise<string[]> {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public'`,
    );
    return rows.map((r) => r.tablename);
  } finally {
    await client.end();
  }
}

describe('ensureDatabase', () => {
  it('creates a missing database, then leaves it as it is', async () => {
    await ensureDatabase(url);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('create table kept (id int)');
    await client.end();
    await ensureDatabase(url);
    expect(await tables()).toEqual(['kept']);
  });

  it('fresh: drops and recreates it, closing the connections still open on it', async () => {
    // its own setup: a database with a table in it, which the drop must take away
    await ensureDatabase(url);
    const setup = new pg.Client({ connectionString: url });
    await setup.connect();
    await setup.query('create table if not exists dropped (id int)');
    await setup.end();
    const leftover = new pg.Client({ connectionString: url });
    const terminated = new Promise<Error>((resolve) => leftover.on('error', resolve));
    await leftover.connect();
    await ensureDatabase(url, { fresh: true });
    expect(await tables()).toEqual([]);
    // 57P01: terminating connection due to administrator command
    expect(await terminated).toMatchObject({ code: '57P01' });
    await leftover.end().catch(() => {});
  });

  it('refuses a database name that would need quoting', async () => {
    const odd = Object.assign(new URL(adminUrl), { pathname: '/bad"name' }).toString();
    await expect(ensureDatabase(odd, { fresh: true })).rejects.toThrow('refusing to create');
  });
});

/**
 * A migrations folder in drizzle-kit's v3 layout (`<14-digit timestamp>_<name>/migration.sql`,
 * which is all the migrator reads), holding `migrations` in order, { name: sql }.
 */
function migrationsFolder(migrations: Record<string, string>): string {
  const dir = mkdtempSync(join(tmp, 'migrations-'));
  Object.entries(migrations).forEach(([what, sql], i) => {
    const folder = join(dir, `2026010100000${i}_${what}`);
    mkdirSync(folder);
    writeFileSync(join(folder, 'migration.sql'), sql);
  });
  return dir;
}

/** The names of the indexes on the public schema's tables. */
async function indexes(dbUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public' order by indexname`,
    );
    return rows.map((r) => r.indexname);
  } finally {
    await client.end();
  }
}

// The db-migration skill (step 5, "A new index on a large table") says `CREATE INDEX CONCURRENTLY`
// cannot be a migration here: the migrator runs every pending migration in one transaction. A
// drizzle-orm release that runs each one on its own, or outside a transaction, fails this, and the
// skill's rule has to change with it.
describe('runMigrations', () => {
  const TABLE = 'create table probe (id int);';
  const CONCURRENTLY = 'create index concurrently probe_id_idx on probe (id);';
  const IF_NOT_EXISTS = 'create index if not exists probe_id_idx on probe (id);';

  it('runs every pending migration in one transaction, where CREATE INDEX CONCURRENTLY fails', async () => {
    await ensureDatabase(migratedUrl, { fresh: true });
    const folder = migrationsFolder({ add_probe: TABLE, add_probe_index: CONCURRENTLY });
    const failure: unknown = await runMigrations(migratedUrl, folder).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure, 'the CONCURRENTLY migration applied').toBeInstanceOf(Error);
    // pg's error, which drizzle-orm wraps (its `cause`): 25001 active_sql_transaction
    const pgError =
      failure instanceof Error && failure.cause instanceof Error ? failure.cause : failure;
    expect(pgError).toMatchObject({
      code: '25001',
      message: 'CREATE INDEX CONCURRENTLY cannot run inside a transaction block',
    });
    // the transaction held both migrations: the table of the first one is gone too
    expect(await tables(migratedUrl)).toEqual([]);
  });

  it('applies CREATE INDEX IF NOT EXISTS over the same index built concurrently beforehand', async () => {
    // production: an earlier deploy made the table
    await ensureDatabase(migratedUrl, { fresh: true });
    await runMigrations(migratedUrl, migrationsFolder({ add_probe: TABLE }));
    // a human builds the index there before the deploy, outside a transaction
    const client = new pg.Client({ connectionString: migratedUrl });
    await client.connect();
    try {
      await client.query(CONCURRENTLY.replace('concurrently', 'concurrently if not exists'));
    } finally {
      await client.end();
    }
    // then the deploy runs the new migration, which skips the index that is there
    const folder = migrationsFolder({ add_probe: TABLE, add_probe_index: IF_NOT_EXISTS });
    await runMigrations(migratedUrl, folder);
    expect(await indexes(migratedUrl)).toEqual(['probe_id_idx']);

    // everywhere else (dev, tests, a new environment) the same migrations build it
    await ensureDatabase(migratedUrl, { fresh: true });
    await runMigrations(migratedUrl, folder);
    expect(await tables(migratedUrl)).toEqual(['probe']);
    expect(await indexes(migratedUrl)).toEqual(['probe_id_idx']);
  });
});
