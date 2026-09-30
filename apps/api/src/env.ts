// The API's environment, validated once at startup (main.ts). Nothing reads process.env at import
// time: the schema must print with an empty environment (print-schema, CI).
import { z } from 'zod';

const Env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /** Set by the platform (Railway); locally `API_PORT` from tools/dev-ports.mjs. */
    PORT: z.coerce.number().int().positive().optional(),
    API_PORT: z.coerce.number().int().positive().optional(),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    /** Shared with the web server (its BFF sends it on every request): the API is private. */
    INTERNAL_API_SECRET: z
      .string()
      .min(32, 'INTERNAL_API_SECRET must be at least 32 characters')
      .optional(),
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.INTERNAL_API_SECRET, {
    path: ['INTERNAL_API_SECRET'],
    message: 'INTERNAL_API_SECRET is required in production',
  });

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
