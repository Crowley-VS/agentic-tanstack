import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** The committed migrations (drizzle-kit v3 layout: one folder per migration). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Create the database named in `url` if it does not exist (connects to the `postgres` database).
 * `fresh` (db:db-seed-e2e, and its own test): drop it first, so it starts empty. WITH (FORCE)
 * closes the connections still open on it (a leftover e2e server's pool), which a plain DROP would
 * wait on.
 */
export async function ensureDatabase(url: string, { fresh = false } = {}): Promise<void> {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.slice(1));
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`refusing to create database "${name}"`);
  const admin = new pg.Client({
    connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).toString(),
  });
  await admin.connect();
  try {
    if (fresh) await admin.query(`drop database if exists "${name}" with (force)`);
    const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', [name]);
    if (!rowCount) await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }
}

/** Apply pending migrations to the database at `url` (idempotent). */
export async function runMigrations(url: string, migrationsFolder = MIGRATIONS_DIR): Promise<void> {
  // lock_timeout: fail fast instead of waiting forever behind a session holding a lock
  const pool = new pg.Pool({ connectionString: url, max: 1, options: '-c lock_timeout=10s' });
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder });
  } finally {
    await pool.end();
  }
}
