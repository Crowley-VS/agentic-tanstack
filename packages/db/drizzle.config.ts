import { defineConfig } from 'drizzle-kit';
// @ts-expect-error plain .mjs script
import { resolveDb } from './scripts/db-up.mjs';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  // committed; one folder per migration (drizzle-kit v1 layout). Never edit an applied one.
  out: './migrations',
  migrations: { table: '__drizzle_migrations', schema: 'drizzle' },
  // DATABASE_URL (CI, prod-like) wins; otherwise this checkout's local Postgres (no Docker call)
  dbCredentials: { url: resolveDb().url },
});
