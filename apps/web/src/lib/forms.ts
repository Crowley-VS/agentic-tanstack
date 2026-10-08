// Form helpers shared by every write: field errors from Zod (checked in the browser first, with the
// API's own schemas from @acme/validators) and from the API's ValidationError, one message for a
// write that failed, and the exhaustive end of a `__typename` switch.
import { RATE_LIMITED, READ_ONLY } from '@acme/validators/error-codes';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { appStatusOptions } from './app-status';
import { GraphQLRequestError } from './graphql/errors';

/** One message per form field, plus `form` for what belongs to no field. */
export type FieldErrors<TField extends string> = Partial<Record<TField | 'form', string>>;

type Issue = { readonly path: readonly PropertyKey[]; readonly message: string };

/**
 * Map issues to the form's fields: Zod issues (path `['title']`) or the API's
 * `ValidationError.fieldErrors` (path `['input', 'title']`: pass `argument: 'input'`). The first
 * message per field wins; one for a path that is not a field (a hidden id) goes to `form`.
 */
export function fieldErrors<TField extends string>(
  issues: readonly Issue[],
  fields: readonly TField[],
  { argument }: { argument?: string } = {},
): FieldErrors<TField> {
  const errors: FieldErrors<TField> = {};
  for (const { path, message } of issues) {
    const [first, second] = argument !== undefined && path[0] === argument ? path.slice(1) : path;
    const key = typeof first === 'string' && second === undefined ? first : undefined;
    const field = fields.find((f) => f === key) ?? 'form';
    errors[field] ??= message;
  }
  return errors;
}

/**
 * What to tell the user when a write threw (expected failures are union members instead): the
 * API's READ_ONLY, the BFF's RATE_LIMITED (its 429 wording, with the wait from `Retry-After`), or
 * a generic message.
 */
export function writeErrorMessage(error: unknown): string {
  if (error instanceof GraphQLRequestError) {
    if (error.code === READ_ONLY) return 'The board is read-only right now: nothing was saved.';
    if (error.code === RATE_LIMITED || error.status === 429)
      // the BFF always sends Retry-After; a 429 from elsewhere may not, and gets no made-up wait
      return error.retryAfter === undefined
        ? 'Too many writes: try again in a moment.'
        : `Too many writes: try again in ${error.retryAfter} s.`;
  }
  return 'Could not save. Check your connection and try again.';
}

/**
 * Handle a write that threw: returns the message for the form, and when the API turned read-only
 * since the page loaded, flips the cached status so every form disables and the banner shows.
 */
export function useWriteError(): (error: unknown) => string {
  const queryClient = useQueryClient();
  return useCallback(
    (error: unknown) => {
      if (error instanceof GraphQLRequestError && error.code === READ_ONLY)
        queryClient.setQueryData(appStatusOptions().queryKey, { readOnly: true });
      return writeErrorMessage(error);
    },
    [queryClient],
  );
}

/**
 * The `default:` of a `__typename` switch: a union member nobody handles fails web:typecheck. At
 * run time (an API deployed ahead of this web build) it logs the result and returns the generic
 * message for the form: a throw here would be an unhandled rejection, and the form would say nothing.
 */
export function unreachable(value: never): string {
  console.error('[web] unhandled write result', value);
  return writeErrorMessage(value);
}
