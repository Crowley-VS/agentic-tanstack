// `pnpm nx run db:db-migrate`: create this checkout's dev database if needed, then migrate it.
// @ts-expect-error plain .mjs script
import { resolveDb } from './db-up.mjs';
import { ensureDatabase, runMigrations } from '../src/migrate';

const { url } = resolveDb();
await ensureDatabase(url);
await runMigrations(url);
console.log(`[db] migrated ${new URL(url).pathname.slice(1)}`);
