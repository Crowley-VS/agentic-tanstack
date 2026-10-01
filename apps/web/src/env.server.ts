// The web server's environment, mirroring apps/api/src/env.ts; the secret's rules come from
// @acme/validators/internal-api, which the API uses too. Server-only: Start's import protection
// fails a client build that imports a `*.server.*` file. Parsed on each call inside request
// handlers, never at import time, so neither the build nor the client bundle depends on (or
// embeds) it.
import { isIP } from 'node:net';
import { InternalApiSecret, SECRET_REQUIRED_IN_PRODUCTION } from '@acme/validators/internal-api';
import { z } from 'zod';

/**
 * A production build (`vite build` inlines `import.meta.env.PROD`) or a production runtime: either
 * one requires the secret and the API's address, so a deploy that forgets NODE_ENV cannot run
 * without them.
 */
const isProduction = (env: { NODE_ENV: string }) =>
  import.meta.env.PROD || env.NODE_ENV === 'production';

/** A host name (`api.railway.internal`, `api`) or a bare IP address: no scheme, port or brackets. */
const isHost = (host: string) => isIP(host) !== 0 || /^[\w-]+(\.[\w-]+)*$/.test(host);

const RATE = /^([1-9]\d*)\/([1-9]\d*)([smh])$/;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };

/** WRITE_RATE_LIMIT: `<writes>/<window>`, the window in s, m or h (`10/60s`); null when `off`. */
const RateLimit = z
  .string()
  .trim()
  .refine((value) => value === 'off' || RATE.test(value), 'must look like 10/60s, or be off')
  .transform((value) => {
    const [, limit, amount, unit = 's'] = RATE.exec(value) ?? [];
    if (!limit || !amount) return null;
    return { limit: Number(limit), windowMs: Number(amount) * (UNIT_MS[unit] ?? 1000) };
  });

/** A write rate limit in force: `limit` writes per client per window of `windowMs`. */
export type RateLimit = NonNullable<z.infer<typeof RateLimit>>;

const ServerEnv = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /** The private API: Railway's internal host in production; this machine in development. */
    API_HOST: z
      .string()
      .refine(
        isHost,
        'API_HOST must be a host name or IP address, without scheme, port or brackets',
      )
      .optional(),
    /** Locally this checkout's API_PORT (tools/dev-ports.mjs); in production the API's port. */
    API_PORT: z.coerce.number().int().positive().max(65_535).optional(),
    /** Sent on every call to the API, which enforces it in production. */
    INTERNAL_API_SECRET: InternalApiSecret,
    /**
     * The request header in which the proxy in front of this server names the browser's IP
     * (server/client-ip.server.ts). Empty: no proxy in front, the socket's address is the client's.
     */
    REAL_IP_HEADER: z.string().trim().toLowerCase().default('x-real-ip'),
    /**
     * Mutations per client through the BFF (server/rate-limit.server.ts), on by default.
     * `prefault`, not `default`: the default value goes through the transform too.
     */
    WRITE_RATE_LIMIT: RateLimit.prefault('10/60s'),
    /** Test-only, set by the e2e servers: turns the write rate limit off. */
    E2E: z.stringbool().default(false),
  })
  .refine((env) => !isProduction(env) || env.INTERNAL_API_SECRET, SECRET_REQUIRED_IN_PRODUCTION)
  // no fallback to this machine in production: a forgotten address fails the healthcheck
  .refine((env) => !isProduction(env) || env.API_HOST, {
    path: ['API_HOST'],
    message: 'API_HOST is required in production',
  })
  .refine((env) => !isProduction(env) || env.API_PORT, {
    path: ['API_PORT'],
    message: 'API_PORT is required in production',
  })
  .transform(({ API_HOST = 'localhost', API_PORT = 4000, WRITE_RATE_LIMIT, E2E, ...env }) => ({
    ...env,
    API_HOST,
    API_PORT,
    /** The write rate limit in force: null when WRITE_RATE_LIMIT is off or E2E is set. */
    writeRateLimit: E2E ? null : WRITE_RATE_LIMIT,
  }));

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
  const host = isIP(env.API_HOST) === 6 ? `[${env.API_HOST}]` : env.API_HOST;
  return `http://${host}:${env.API_PORT}/graphql`;
}
