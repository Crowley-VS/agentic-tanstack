// `pnpm nx run db:db-seed-e2e`: this checkout's e2e database (E2E_DATABASE_URL, else the one
// tools/dev-ports.mjs names; never DATABASE_URL), dropped, recreated, migrated and seeded.
// api:serve-e2e depends on it, so every e2e run starts from the same data; dev data is never touched.
// @ts-expect-error plain .mjs script
import { isLocalUrl, resolveDb } from './db-up.mjs';
import { createDb } from '../src/client';
import { ensureDatabase, runMigrations } from '../src/migrate';
import { SEED, seed } from '../src/seed';

const { e2eUrl: url } = resolveDb();
// it drops the database: never a remote one, and there is no opt-in
if (!isLocalUrl(url)) {
  console.error(`[db] refusing to recreate a non-local database (${new URL(url).hostname})`);
  process.exit(1);
}
await ensureDatabase(url, { fresh: true });
await runMigrations(url);
const { db, close } = createDb({ url, max: 1 });
try {
  await seed(db);
} finally {
  await close();
}
console.log(
  `[db] ${new URL(url).pathname.slice(1)}: recreated, migrated, ${SEED.notes} seed notes`,
);
