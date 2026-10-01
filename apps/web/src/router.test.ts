// The wiring (router.tsx, routes/__root.tsx, routes/index.tsx) without a server. Start calls
// getRouter() for every request, so each must get its own QueryClient: a shared one would serve
// one user's data to another. Test files stay out of src/routes (the route generator would take
// them for routes).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldRetry } from './lib/graphql/execute';
import { getRouter } from './router';
import { Route as RootRoute } from './routes/__root';
import { Route as HomeRoute } from './routes/index';

// node tests do not process CSS (its ?url is ''): give the app stylesheet a URL to look for
vi.mock('./styles.css?url', () => ({ default: '/assets/styles.css' }));

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

  it("has one not-found page, the router's default: the root route sets none of its own", () => {
    expect(getRouter().options.defaultNotFoundComponent).toBeTypeOf('function');
    expect(RootRoute.options.notFoundComponent).toBeUndefined();
  });
});

describe('the root route', () => {
  it('links the app stylesheet from every page', async () => {
    const head: unknown = Reflect.get(RootRoute.options, 'head');
    if (typeof head !== 'function') throw new Error('the root route has no head()');
    const { links } = await head({});
    // styles.test.ts builds src/styles.css; without this link no page uses it
    expect(links).toContainEqual({ rel: 'stylesheet', href: '/assets/styles.css' });
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
