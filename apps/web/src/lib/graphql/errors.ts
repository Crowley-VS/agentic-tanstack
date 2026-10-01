// How a GraphQL request fails, for execute() and for the code that handles its errors (the error
// page, forms). No framework imports: browser tests mock execute() and keep these real.

/** The message of a call that got no answer: nothing listens, or the environment is invalid (502). */
export const API_UNAVAILABLE = 'API unavailable';
/** The message of a call the API did not answer in time (504). */
export const API_TIMED_OUT = 'API timed out';

/** One entry of a GraphQL response's top-level `errors`. */
export type GraphQLErrorEntry = {
  message: string;
  path?: readonly (string | number)[];
  extensions?: Record<string, unknown>;
};

type GraphQLRequestErrorOptions = {
  /** Seconds to wait before trying again, from the answer's `Retry-After` header. */
  retryAfter?: number;
  /** What failed underneath (a network error, an invalid environment): for the server log. */
  cause?: unknown;
};

/**
 * A request that failed: top-level GraphQL `errors` (a document the schema rejects, a masked
 * server error, a BFF refusal) or a transport failure (a non-2xx answer without them, or on the
 * server an API that never answered). Expected failures are not errors: mutations return them as
 * union members, selected by `__typename`.
 */
export class GraphQLRequestError extends Error {
  override name = 'GraphQLRequestError';
  readonly status: number;
  readonly errors: readonly GraphQLErrorEntry[];
  /** Seconds to wait before trying again, from a `Retry-After` header (a 429 or 503 answer). */
  readonly retryAfter: number | undefined;

  constructor(
    status: number,
    errors: readonly GraphQLErrorEntry[] = [],
    { retryAfter, cause }: GraphQLRequestErrorOptions = {},
  ) {
    super(
      errors.length
        ? errors.map((e) => e.message).join('; ')
        : `GraphQL request failed (HTTP ${status})`,
      cause === undefined ? undefined : { cause },
    );
    this.status = status;
    this.errors = errors;
    this.retryAfter = retryAfter;
  }

  /** The first error's `extensions.code`, e.g. READ_ONLY (the API) or RATE_LIMITED (the BFF). */
  get code(): string | undefined {
    const code = this.errors[0]?.extensions?.code;
    return typeof code === 'string' ? code : undefined;
  }
}

/**
 * A `Retry-After` header in whole seconds (at least 1): delta-seconds, or an HTTP date (always
 * GMT); `undefined` when it is missing or unreadable.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  const value = header?.trim() ?? '';
  let ms = Number.NaN;
  if (/^\d+$/.test(value)) ms = Number(value) * 1000;
  // Date.parse alone would read "-5" as a date in 2001
  else if (value.endsWith(' GMT')) ms = Date.parse(value) - now;
  return Number.isNaN(ms) ? undefined : Math.max(1, Math.ceil(ms / 1000));
}
