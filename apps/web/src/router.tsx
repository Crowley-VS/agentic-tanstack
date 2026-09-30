// Start's router entry (it must be src/router.tsx exporting getRouter). Start calls getRouter()
// for every server request (SSR and /api/* alike) and once in the browser: keep it free of I/O.
// Each call gets its own QueryClient, so no request (user) sees another's data.
// Route types need no `declare module` here: routeTree.gen.ts registers the router with Start.
import { QueryClient, useQueryErrorResetBoundary } from '@tanstack/react-query';
import { createRouter, type ErrorComponentProps, useRouter } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';
import { useEffect } from 'react';
import { shouldRetry } from './lib/graphql/execute';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      // > 0, or a browser that hydrates more than 1 s after SSR refetches what it just received
      queries: { staleTime: 30_000, retry: shouldRetry },
    },
  });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: 'intent',
    // TanStack Query decides freshness: loaders always run; ensureQueryData() is free when cached
    defaultPreloadStaleTime: 0,
    defaultNotFoundComponent: () => <p>Not found.</p>,
    defaultErrorComponent: ErrorPage,
  });
  // dehydrates the query cache into the SSR stream, hydrates it in the browser, and provides the
  // QueryClientProvider (so none of our own)
  setupRouterSsrQueryIntegration({ router, queryClient });
  return router;
}

/** A route whose loader or query failed: the message, and a way to load it again. */
function ErrorPage({ error }: ErrorComponentProps) {
  const router = useRouter();
  const queryErrorResetBoundary = useQueryErrorResetBoundary();
  // a query that failed while rendering may fetch again on the next render
  useEffect(() => queryErrorResetBoundary.reset(), [queryErrorResetBoundary]);
  return (
    <div role="alert">
      <p>Something went wrong: {error instanceof Error ? error.message : String(error)}</p>
      <button type="button" onClick={() => void router.invalidate()}>
        Try again
      </button>
    </div>
  );
}
