// The router's default error component: a route whose loader or query failed. During SSR it is
// where a failed page load surfaces, so it logs the error (with its cause) on the server.
import { Button } from '@acme/ui/components/button';
import { useQueryErrorResetBoundary } from '@tanstack/react-query';
import { type ErrorComponentProps, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { API_TIMED_OUT, API_UNAVAILABLE } from '../lib/graphql/errors';

/**
 * What a failed page tells the visitor, decided by the error's message alone: an SSR error
 * reaches the browser as a plain Error with the same message, so a class check would render
 * differently there and break hydration. The message itself only in development: in production
 * it can carry server detail, and SSR serializes the page's text into the HTML.
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
  // render runs once per failed server render; the browser's console already shows its own
  if (router.isServer) console.error('[web] SSR: a page failed to load', error);
  // a query that failed while rendering may fetch again on the next render
  useEffect(() => queryErrorResetBoundary.reset(), [queryErrorResetBoundary]);
  return (
    <div role="alert" className="flex flex-col items-start gap-3 p-6">
      <p>{errorPageMessage(error)}</p>
      <Button type="button" variant="outline" onClick={() => void router.invalidate()}>
        Try again
      </Button>
    </div>
  );
}
