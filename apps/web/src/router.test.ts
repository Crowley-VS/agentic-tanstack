// The data wiring (router.tsx, routes/index.tsx) without a server. Start calls getRouter() for
// every request, so each must get its own QueryClient: a shared one would serve one user's data
// to another. Test files stay out of src/routes (the route generator would take them for routes).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldRetry } from './lib/graphql/execute';
import { getRouter } from './router';
import { Route as HomeRoute } from './routes/index';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getRouter', () => {
  it('gives every request its own QueryClient, with the app defaults', () => {
    const client = getRouter().options.context.queryClient;
    expect(client).not.toBe(getRouter().options.context.queryClient);
    expect(client.getDefaultOptions().queries).toMatchObject({
      staleTime: 30_000,
      retry: shouldRetry,
    });
  });
});

describe('the home route', () => {
  it('loads the API version into the query cache and returns nothing', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ data: { apiVersion: 'v1' } }));
    const { queryClient } = getRouter().options.context;
    const loader: unknown = Reflect.get(HomeRoute.options, 'loader');
    if (typeof loader !== 'function') throw new Error('the home route has no loader');
    // returned data would be serialized into the page a second time, next to the dehydrated cache
    await expect(loader({ context: { queryClient } })).resolves.toBeUndefined();
    expect(queryClient.getQueryData(['apiVersion'])).toEqual({ apiVersion: 'v1' });
  });
});
