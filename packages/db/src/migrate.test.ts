// ensureDatabase() on a database of its own (not the test file's clone): created once and then
// kept; `fresh` (db:db-seed-e2e) drops it first, even while a leftover e2e server is connected.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDatabase } from './migrate';

// named after this file's clone (t_<run>_…), so the global setup drops it if afterAll never runs
const clone = new URL(process.env.TEST_FILE_DATABASE_URL ?? '');
const name = `${clone.pathname.slice(1)}_ensure`;
const url = Object.assign(new URL(clone), { pathname: `/${name}` }).toString();
const adminUrl = Object.assign(new URL(clone), { pathname: '/postgres' }).toString();
const admin = new pg.Client({ connectionString: adminUrl });

beforeAll(() => admin.connect());
afterAll(async () => {
  await admin.query(`drop database if exists "${name}" with (force)`);
  await admin.end();
});

async function tables(): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
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
