// The HTML shell every page renders in (SSR). Loaders get the request's QueryClient as
// `context.queryClient`; the error and not-found pages are router.tsx's defaults.
import { Toaster } from '@acme/ui/components/sonner';
import { ThemeProvider } from '@acme/ui/components/theme-provider';
import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import appCss from '../styles.css?url';

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'acme-app' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      // an empty icon: browsers otherwise request /favicon.ico, a 404
      { rel: 'icon', href: 'data:,' },
    ],
  }),
  shellComponent: RootDocument,
  component: () => <Outlet />,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    // next-themes sets class="dark" or "light" on <html> before hydration
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <ThemeProvider>
          {children}
          <Toaster />
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}
