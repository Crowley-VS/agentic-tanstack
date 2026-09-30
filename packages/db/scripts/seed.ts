// `pnpm nx run db:db-seed`: replace this checkout's dev data with the deterministic seed.
// @ts-expect-error plain .mjs script
import { isLocalUrl, resolveDb } from './db-up.mjs';
import { createDb } from '../src/client';
import { SEED, seed } from '../src/seed';

const { url } = resolveDb();
if (!isLocalUrl(url)) {
  console.error(`[db] refusing to seed a non-local database (${new URL(url).hostname})`);
  process.exit(1);
}
const { db, close } = createDb({ url, max: 1 });
try {
  await seed(db);
  console.log(`[db] seeded ${SEED.notes} notes into ${new URL(url).pathname.slice(1)}`);
} finally {
  await close();
}
