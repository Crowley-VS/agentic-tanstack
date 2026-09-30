import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { relations } from './relations';

export type DbOptions = {
  url: string;
  /** Pool size (default 10). */
  max?: number;
  /** Receives every SQL statement (used by tests that count queries). */
  onQuery?: (sql: string) => void;
};

/** A database handle plus the pool behind it. Call `close()` on shutdown. */
export function createDb({ url, max = 10, onQuery }: DbOptions) {
  const pool = new pg.Pool({ connectionString: url, max });
  // Without a listener, an idle connection closed by the server (a restart, a dropped database)
  // emits an unhandled 'error' and crashes the process.
  pool.on('error', (err) => console.warn(`[db] idle connection error: ${err.message}`));
  const db = drizzle({
    client: pool,
    relations,
    ...(onQuery ? { logger: { logQuery: (query: string) => onQuery(query) } } : {}),
  });
  return { db, pool, close: () => pool.end() };
}

export type Db = ReturnType<typeof createDb>['db'];
