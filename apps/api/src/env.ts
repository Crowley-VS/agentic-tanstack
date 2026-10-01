// The API's environment, validated once at startup (main.ts). Nothing reads process.env at import
// time: the schema must print with an empty environment (print-schema, CI).
import { InternalApiSecret, SECRET_REQUIRED_IN_PRODUCTION } from '@acme/validators/internal-api';
import { z } from 'zod';

const Env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /** Set by the platform (Railway); locally `API_PORT` from tools/dev-ports.mjs. */
    PORT: z.coerce.number().int().positive().optional(),
    API_PORT: z.coerce.number().int().positive().optional(),
    /** The address to listen on; `listenHost()` below has the default. */
    LISTEN_HOST: z.string().min(1).optional(),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    /** Kill switch: reject every mutation (e.g. while abuse is being dealt with). */
    READ_ONLY: z.stringbool().default(false),
    /** Shared with the web server (its BFF sends it on every request): the API is private. */
    INTERNAL_API_SECRET: InternalApiSecret,
  })
  .refine(
    (env) => env.NODE_ENV !== 'production' || env.INTERNAL_API_SECRET,
    SECRET_REQUIRED_IN_PRODUCTION,
  );

export type Env = z.infer<typeof Env>;

/** Parse and validate `source` (process.env by default); throws one message listing every problem. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = Env.safeParse(source);
  if (!result.success)
    throw new Error(
      `invalid API environment:\n${result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    );
  return result.data;
}

/** The port to listen on: the platform's PORT, else this checkout's API_PORT, else 4000. */
export const listenPort = (env: Env) => env.PORT ?? env.API_PORT ?? 4000;

/**
 * The address to listen on: LISTEN_HOST when set (e.g. 127.0.0.1 for a production-mode run only
 * this machine can reach); else `::` in production (IPv6 and IPv4: Railway's private network is
 * IPv6-only), and this machine only in development, which serves GraphiQL and introspection and
 * ignores the secret (app.ts enforces it with NODE_ENV=production only). Not `HOST`, which a shell
 * or platform may export for other reasons.
 */
export const listenHost = (env: Env) =>
  env.LISTEN_HOST ?? (env.NODE_ENV === 'production' ? '::' : '127.0.0.1');
