// The web server's environment, mirroring apps/api/src/env.ts. Server-only: Start's import
// protection fails a client build that imports a `*.server.*` file. Parsed on each call inside
// request handlers, never at import time, so neither the build nor the client bundle depends on
// (or embeds) it.
import { z } from 'zod';

/**
 * A production build (`vite build` inlines `import.meta.env.PROD`) or a production runtime: either
 * one requires the secret, so a deploy that forgets NODE_ENV cannot run without it.
 */
const isProduction = (env: { NODE_ENV: string }) =>
  import.meta.env.PROD || env.NODE_ENV === 'production';

const ServerEnv = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /** The private API: Railway's internal host in production; this machine in development. */
    API_HOST: z.string().min(1).default('localhost'),
    /** Locally this checkout's API_PORT (tools/dev-ports.mjs); in production the API's port. */
    API_PORT: z.coerce.number().int().positive().default(4000),
    /** Sent on every call to the API, which enforces it in production. */
    INTERNAL_API_SECRET: z
      .string()
      .min(32, 'INTERNAL_API_SECRET must be at least 32 characters')
      .optional(),
  })
  .refine((env) => !isProduction(env) || env.INTERNAL_API_SECRET, {
    path: ['INTERNAL_API_SECRET'],
    message: 'INTERNAL_API_SECRET is required in production',
  });

export type ServerEnv = z.infer<typeof ServerEnv>;

/** Parse and validate `source` (process.env by default); throws one message listing every problem. */
export function serverEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  const result = ServerEnv.safeParse(source);
  if (!result.success)
    throw new Error(
      `invalid web environment:\n${result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    );
  return result.data;
}

/** The API's GraphQL endpoint. An IPv6 literal (Railway's private network) gets brackets. */
export function internalApiUrl(env: ServerEnv): string {
  const host = env.API_HOST.includes(':') ? `[${env.API_HOST}]` : env.API_HOST;
  return `http://${host}:${env.API_PORT}/graphql`;
}
