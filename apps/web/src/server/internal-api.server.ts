// Server-only: how the web server reaches the private GraphQL API (the BFF proxy, and execute()
// during SSR). The `.server.ts` suffix makes TanStack Start's import protection fail the build if
// client code imports this file. The header names are the contract in @acme/validators.
import { randomUUID } from 'node:crypto';
import { CLIENT_IP_HEADER, REQUEST_ID_HEADER, SECRET_HEADER } from '@acme/validators/internal-api';
import { internalApiUrl, type ServerEnv } from '../env.server';
import { API_TIMED_OUT, API_UNAVAILABLE } from '../lib/graphql/errors';

export const TIMEOUT_MS = 10_000;

type CallOptions = {
  /** Aborts the call, e.g. when the browser goes away. */
  signal?: AbortSignal;
  /** The browser's IP, for the API's log (it trusts it only with the secret). */
  clientIp?: string;
  /** Ties the web and API log lines together; a new one when not given. */
  requestId?: string;
  timeoutMs?: number;
};

/**
 * POST a GraphQL request body (JSON text) to the API, with the shared secret when one is set and
 * a request id. Gives up after `timeoutMs` (a TimeoutError), or as soon as `signal` aborts.
 */
export function callInternalApi(
  env: ServerEnv,
  body: string,
  { signal, clientIp, requestId = randomUUID(), timeoutMs = TIMEOUT_MS }: CallOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/graphql-response+json, application/json',
    [REQUEST_ID_HEADER]: requestId,
  };
  if (env.INTERNAL_API_SECRET) headers[SECRET_HEADER] = env.INTERNAL_API_SECRET;
  if (clientIp) headers[CLIENT_IP_HEADER] = clientIp;
  const timeout = AbortSignal.timeout(timeoutMs);
  return fetch(internalApiUrl(env), {
    method: 'POST',
    headers,
    body,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
}

/** How a call that never got an answer is reported: 504 when it timed out, else 502. */
export function transportFailure(err: unknown): { status: 502 | 504; message: string } {
  return err instanceof Error && err.name === 'TimeoutError'
    ? { status: 504, message: API_TIMED_OUT }
    : { status: 502, message: API_UNAVAILABLE };
}
