// The HTML shell every page renders in (SSR) and the layout around every page. Loaders get the
// request's QueryClient as `context.queryClient`; the error and not-found pages are router.tsx's
// defaults. The root loader fills the app status (read-only or not) that the banner reads.
import { Toaster } from '@acme/ui/components/sonner';
import { ThemeProvider } from '@acme/ui/components/theme-provider';
import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { ReadOnlyBanner } from '../components/read-only-banner';
import { appStatusOptions } from '../lib/app-status';
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
  // for every page: whatever calls useReadOnly() (the banner) finds it in the cache
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(appStatusOptions());
  },
  shellComponent: RootDocument,
  component: Layout,
});

function Layout() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6">
      <header>
        <Link to="/" className="text-sm font-semibold tracking-tight">
          acme-app
        </Link>
      </header>
      <ReadOnlyBanner />
      <main className="flex flex-col gap-6">
        <Outlet />
      </main>
    </div>
  );
}

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
