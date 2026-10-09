// Deploy-time migrations: `node dist/migrate.mjs` before `node dist/main.mjs` (the build copies
// the committed migrations next to dist/, where MIGRATIONS_DIR finds them). Locally, use
// `pnpm db:migrate` instead.
import { MIGRATIONS_DIR, runMigrations } from '@acme/db';
import { createLogger, logFormat } from '@acme/logger';
import { z } from 'zod';

const { DATABASE_URL } = z
  .object({ DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }) })
  .parse(process.env);
const dir = process.env.MIGRATIONS_DIR ?? MIGRATIONS_DIR;
const log = createLogger({
  app: 'api',
  format: logFormat(process.env),
  version: process.env.APP_VERSION ?? 'dev',
});
await runMigrations(DATABASE_URL, dir);
log.info(`migrations applied from ${dir}`);
