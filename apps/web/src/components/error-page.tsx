// The router's default error component: a route whose loader or query failed. During SSR it is
// where a failed page load surfaces, so it logs the error (with its cause) on the server.
import { Button } from '@acme/ui/components/button';
import { useQueryErrorResetBoundary } from '@tanstack/react-query';
import { type ErrorComponentProps, useHydrated, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { API_TIMED_OUT, API_UNAVAILABLE } from '../lib/graphql/errors';
import { logServerError } from '../lib/log';

/**
 * What a failed page tells the visitor, decided by the error's message alone: an SSR error
 * reaches the browser as a plain Error with the same message, so a class check would render
 * differently there and break hydration. The message itself only in development, for the
 * visitor's sake: it is not secret, since the router serializes every failed match's message into
 * the page (its dehydrated state) either way. Server detail belongs in `cause`, which stays on the
 * server (execute() does this).
 */
export function errorPageMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (import.meta.env.DEV) return `Something went wrong: ${message}`;
  if (message === API_UNAVAILABLE || message === API_TIMED_OUT)
    return 'The server is not answering right now. Try again in a moment.';
  return 'Something went wrong while loading this page.';
}

/** A route whose loader or query failed: what happened, and a way to load it again. */
export function ErrorPage({ error }: Pick<ErrorComponentProps, 'error'>) {
  const router = useRouter();
  const queryErrorResetBoundary = useQueryErrorResetBoundary();
  // a click before hydration would be lost: the button waits for React (docs/web.md)
  const hydrated = useHydrated();
  // render runs once per failed server render (logged with the request id); the browser's console
  // already shows its own
  if (router.isServer) logServerError('SSR: a page failed to load', error);
  // a query that failed while rendering may fetch again on the next render
  useEffect(() => queryErrorResetBoundary.reset(), [queryErrorResetBoundary]);
  return (
    <div role="alert" className="flex flex-col items-start gap-3 p-6">
      <p>{errorPageMessage(error)}</p>
      <Button
        type="button"
        variant="outline"
        disabled={!hydrated}
        onClick={() => void router.invalidate()}
      >
        Try again
      </Button>
    </div>
  );
}
