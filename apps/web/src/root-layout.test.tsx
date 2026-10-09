// The root route's layout (routes/__root.tsx) as the server renders it around every page: the
// read-only banner shows while the app status the root loader cached says so. Test files stay out
// of src/routes (the route generator would take them for routes).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { appStatusOptions } from './lib/app-status';
import { Route as RootRoute } from './routes/__root';

// node tests do not process CSS (its ?url is '')
vi.mock('./styles.css?url', () => ({ default: '/assets/styles.css' }));

/** The root layout's server markup, over the app status the root loader would have cached. */
async function renderLayout(readOnly: boolean) {
  const Layout = RootRoute.options.component;
  if (!Layout) throw new Error('the root route has no component');
  const queryClient = new QueryClient();
  queryClient.setQueryData(appStatusOptions().queryKey, { readOnly });
  const router = createRouter({
    routeTree: createRootRoute({ component: Layout }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('the root layout', () => {
  it('shows the read-only banner on every page while the API is read-only', async () => {
    expect(await renderLayout(true)).toContain('Read-only mode');
  });

  it('shows no banner while the API accepts writes', async () => {
    const html = await renderLayout(false);
    expect(html).toContain('<main');
    expect(html).not.toContain('Read-only mode');
  });
});
