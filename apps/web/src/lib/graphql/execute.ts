// The app's only way to the API: execute() runs a typed graphql() document (src/gql) and returns
// its typed `data`. On the server (SSR, loaders) it calls the private API directly with the
// internal secret; in the browser it POSTs to the same-origin BFF (/api/graphql), so the secret
// never leaves the server. The Start compiler drops the .server() branch and its *.server imports
// from the client bundle (web:build's bundle check fails otherwise).
import { environmentManager } from '@tanstack/react-query';
import { createIsomorphicFn } from '@tanstack/react-start';
import { serverEnv } from '../../env.server';
import type { TypedDocumentString } from '../../gql/graphql';
import { callInternalApi } from '../../server/internal-api.server';

/** The BFF route (routes/api/graphql.ts). */
export const BFF_PATH = '/api/graphql';

/** One entry of a GraphQL response's top-level `errors`. */
export type GraphQLErrorEntry = {
  message: string;
  path?: readonly (string | number)[];
  extensions?: Record<string, unknown>;
};

type GraphQLResponse<TData> = { data?: TData | null; errors?: readonly GraphQLErrorEntry[] };

/**
 * A request that failed: top-level GraphQL `errors` (a document the schema rejects, a masked
 * server error, a BFF refusal) or a transport failure (a non-2xx answer without them). Expected
 * failures are not errors: mutations return them as union members, selected by `__typename`.
 */
export class GraphQLRequestError extends Error {
  override name = 'GraphQLRequestError';
  readonly status: number;
  readonly errors: readonly GraphQLErrorEntry[];

  constructor(status: number, errors: readonly GraphQLErrorEntry[] = []) {
    super(
      errors.length
        ? errors.map((e) => e.message).join('; ')
        : `GraphQL request failed (HTTP ${status})`,
    );
    this.status = status;
    this.errors = errors;
  }
}

// Untyped transport: createIsomorphicFn fixes its argument types (no generics), so the typed
// execute() below wraps it.
const post = createIsomorphicFn()
  .server((body: string, signal?: AbortSignal) => callInternalApi(serverEnv(), body, { signal }))
  .client((body: string, signal?: AbortSignal) =>
    fetch(BFF_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/graphql-response+json, application/json',
      },
      body,
      signal,
    }),
  );

type ExecuteInit = { signal?: AbortSignal };

/** Operations without variables take none (pass `undefined` to reach `init`); others need theirs. */
type ExecuteArgs<TVariables> =
  TVariables extends Record<string, never>
    ? [variables?: TVariables, init?: ExecuteInit]
    : [variables: TVariables, init?: ExecuteInit];

/** Run a graphql() document; resolves to its typed `data`, rejects with a GraphQLRequestError. */
export async function execute<TResult, TVariables>(
  document: TypedDocumentString<TResult, TVariables>,
  ...[variables, init]: ExecuteArgs<TVariables>
): Promise<TResult> {
  // toString(): a TypedDocumentString is a String object, not a primitive string
  const body = JSON.stringify({ query: document.toString(), variables });
  const response = await post(body, init?.signal);
  const json: GraphQLResponse<TResult> | null = await response.json().catch(() => null);
  if (json?.errors?.length) throw new GraphQLRequestError(response.status, json.errors);
  if (!response.ok || json?.data == null) throw new GraphQLRequestError(response.status);
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
