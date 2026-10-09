// The app's only way to the API: execute() runs a typed graphql() document (src/gql) and returns
// its typed `data`. On the server (SSR, loaders) it calls the private API directly with the
// internal secret; in the browser it POSTs to the same-origin BFF (/api/graphql), so the secret
// never leaves the server. The Start compiler drops the .server() branch and its *.server imports
// from the client bundle (web:build's bundle check fails otherwise).
import { environmentManager } from '@tanstack/react-query';
import { createIsomorphicFn } from '@tanstack/react-start';
import { serverEnv } from '../../env.server';
import { TypedDocumentString } from '../../gql/graphql';
import { callInternalApi, transportFailure } from '../../server/internal-api.server';
import { currentRequestContext } from '../../server/request-context.server';
import { type GraphQLErrorEntry, GraphQLRequestError, parseRetryAfter } from './errors';

/** The BFF route (routes/api/graphql.ts). */
export const BFF_PATH = '/api/graphql';

type GraphQLResponse<TData> = { data?: TData | null; errors?: readonly GraphQLErrorEntry[] };

/**
 * The browser's transport: the same-origin BFF. Exported for its test: without the Start compiler
 * (Vitest), createIsomorphicFn always runs its .server() branch.
 */
export const postToBff = (body: string, signal?: AbortSignal) =>
  fetch(BFF_PATH, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/graphql-response+json, application/json',
    },
    body,
    signal,
  });

// Untyped transport: createIsomorphicFn fixes its argument types (no generics), so the typed
// execute() below wraps it.
const post = createIsomorphicFn()
  // The call carries the page request's id and client IP, so the API's log line for it matches
  // the web server's line for the page. A call that gets no answer fails like the BFF's: 502 'API
  // unavailable' or 504 'API timed out'. The cause (a host name, an invalid environment) stays on
  // the server, out of the SSR payload; the error page logs it. The caller's abort passes through.
  .server(async (body: string, signal?: AbortSignal) => {
    try {
      return await callInternalApi(serverEnv(), body, { signal, ...currentRequestContext() });
    } catch (err) {
      if (signal?.aborted) throw err;
      const { status, message } = transportFailure(err);
      throw new GraphQLRequestError(status, [{ message }], { cause: err });
    }
  })
  .client(postToBff);

type ExecuteInit = { signal?: AbortSignal };

/**
 * Variables may be left out when an empty object satisfies them (an operation without variables,
 * or with optional ones only; pass `undefined` to reach `init`); otherwise they are required.
 */
type ExecuteArgs<TVariables> = {} extends TVariables
  ? [variables?: TVariables, init?: ExecuteInit]
  : [variables: TVariables, init?: ExecuteInit];

/**
 * Run a graphql() document; resolves to its typed `data`. Rejects with a GraphQLRequestError for
 * GraphQL errors, failed answers and, on the server, an API that never answered (502/504). In
 * the browser, network failures and aborts reject as fetch does.
 */
export async function execute<TResult, TVariables>(
  document: TypedDocumentString<TResult, TVariables>,
  ...[variables, init]: ExecuteArgs<TVariables>
): Promise<TResult> {
  // graphql() returns {} for an operation src/gql does not have yet: posting it would send
  // "[object Object]" and fail with a cryptic syntax error
  if (!(document instanceof TypedDocumentString))
    throw new Error('GraphQL operation not generated: run `pnpm nx run web:codegen`');
  // toString(): a TypedDocumentString is a String object, not a primitive string
  const body = JSON.stringify({ query: document.toString(), variables });
  const response = await post(body, init?.signal);
  const json: GraphQLResponse<TResult> | null = await response.json().catch(() => null);
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
  if (json?.errors?.length)
    throw new GraphQLRequestError(response.status, json.errors, { retryAfter });
  if (!response.ok || json?.data == null)
    throw new GraphQLRequestError(response.status, [], { retryAfter });
  return json.data;
}

/**
 * The QueryClient's `retry`. Never on the server: SSR answers at once (the error page) instead of
 * waiting. Never for GraphQL errors in a 2xx or 4xx answer: the same request fails the same way.
 * Otherwise (network failures, 5xx such as the BFF's 502 while the API restarts) up to 3 times.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (environmentManager.isServer()) return false;
  if (error instanceof GraphQLRequestError && error.errors.length > 0 && error.status < 500)
    return false;
  return failureCount < 3;
}
