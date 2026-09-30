// Deploy-time migrations: `node dist/migrate.mjs` before `node dist/main.mjs` (the build copies
// the committed migrations next to dist/, where MIGRATIONS_DIR finds them). Locally, use
// `pnpm db:migrate` instead.
import { MIGRATIONS_DIR, runMigrations } from '@acme/db';
import { z } from 'zod';

const { DATABASE_URL } = z
  .object({ DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }) })
  .parse(process.env);
const dir = process.env.MIGRATIONS_DIR ?? MIGRATIONS_DIR;
await runMigrations(DATABASE_URL, dir);
console.log(`[api] migrations applied from ${dir}`);
