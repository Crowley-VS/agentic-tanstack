// Server-only: how the web server reaches the private GraphQL API (the BFF proxy, and execute()
// during SSR). The `.server.ts` suffix makes TanStack Start's import protection fail the build if
// client code imports this file.
import { internalApiUrl, type ServerEnv } from '../env.server';

export const SECRET_HEADER = 'x-internal-secret';
export const TIMEOUT_MS = 10_000;

/**
 * POST a GraphQL request body (JSON text) to the API, with the shared secret when one is set.
 * Gives up after TIMEOUT_MS, or as soon as `signal` aborts (the browser went away).
 */
export function callInternalApi(
  env: ServerEnv,
  body: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/graphql-response+json, application/json',
  };
  if (env.INTERNAL_API_SECRET) headers[SECRET_HEADER] = env.INTERNAL_API_SECRET;
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return fetch(internalApiUrl(env), {
    method: 'POST',
    headers,
    body,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
}
