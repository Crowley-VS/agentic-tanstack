// The HTML shell every page renders in (SSR), plus the not-found page. Loaders get the request's
// QueryClient as `context.queryClient` (router.tsx).
import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import type { ReactNode } from 'react';

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'acme-app' },
    ],
    // an empty icon: browsers otherwise request /favicon.ico, a 404
    links: [{ rel: 'icon', href: 'data:,' }],
  }),
  shellComponent: RootDocument,
  component: () => <Outlet />,
  notFoundComponent: () => <p>Not found.</p>,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
