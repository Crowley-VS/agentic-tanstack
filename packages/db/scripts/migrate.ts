// `pnpm nx run db:db-migrate`: create this checkout's dev database if needed, then migrate it.
// @ts-expect-error plain .mjs script
import { isLocalUrl, resolveDb } from './db-up.mjs';
import { ensureDatabase, runMigrations } from '../src/migrate';

const { url } = resolveDb();
// auto-approved for agents: never migrate a remote database (e.g. an exported Railway URL) unasked
if (!isLocalUrl(url) && process.env.DB_ALLOW_REMOTE !== '1') {
  console.error(
    `[db] refusing to migrate a non-local database (${new URL(url).hostname}); set DB_ALLOW_REMOTE=1 to migrate it anyway`,
  );
  process.exit(1);
}
await ensureDatabase(url);
await runMigrations(url);
console.log(`[db] migrated ${new URL(url).pathname.slice(1)}`);
