// The data wiring (router.tsx and the route loaders) without a server. Start calls getRouter() for
// every request, so each must get its own QueryClient: a shared one would serve one user's data
// to another. Test files stay out of src/routes (the route generator would take them for routes).
import { isNotFound } from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appStatusOptions } from './lib/app-status';
import { shouldRetry } from './lib/graphql/execute';
import { noteOptions, notesOptions } from './lib/notes/queries';
import { getRouter } from './router';
import { Route as RootRoute } from './routes/__root';
import { Route as BoardRoute } from './routes/index';
import { Route as NoteRoute } from './routes/notes/$noteId';

// node tests do not process CSS (its ?url is ''): give the app stylesheet a URL to look for
vi.mock('./styles.css?url', () => ({ default: '/assets/styles.css' }));

const NOTE_ID = '0198f3c0-0000-7000-8000-000000000000';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The API (stubbed fetch) answers `data`; returns the bodies it received. */
function stubApi(data: unknown) {
  const bodies: { query: string; variables?: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(typeof init.body === 'string' ? init.body : 'null'));
    return Response.json({ data });
  });
  return bodies;
}

/** A route's loader, called the way the router calls it, with a new request's QueryClient. */
function loaderOf(route: { options: object }) {
  const loader: unknown = Reflect.get(route.options, 'loader');
  if (typeof loader !== 'function') throw new Error('the route has no loader');
  const { queryClient } = getRouter().options.context;
  return {
    queryClient,
    load: (params: Record<string, string> = {}): Promise<unknown> =>
      loader({ context: { queryClient }, params }),
  };
}

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

// Loaders return nothing: returned data would be serialized into the page a second time, next
// to the dehydrated query cache.
describe('route loaders', () => {
  it('root: loads whether the API accepts writes', async () => {
    stubApi({ readOnly: true });
    const { queryClient, load } = loaderOf(RootRoute);
    await expect(load()).resolves.toBeUndefined();
    expect(queryClient.getQueryData(appStatusOptions().queryKey)).toEqual({ readOnly: true });
  });

  it('board: loads the first page of notes', async () => {
    const page = { notes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } };
    const sent = stubApi(page);
    const { queryClient, load } = loaderOf(BoardRoute);
    await expect(load()).resolves.toBeUndefined();
    expect(queryClient.getQueryData(notesOptions().queryKey)?.pages).toEqual([page]);
    expect(sent[0]?.variables).toEqual({ first: 20, after: null });
  });

  it('note: loads the note', async () => {
    const note = {
      id: NOTE_ID,
      title: 't',
      body: 'b',
      createdAt: '',
      commentCount: 0,
      comments: [],
    };
    const sent = stubApi({ note });
    const { queryClient, load } = loaderOf(NoteRoute);
    await expect(load({ noteId: NOTE_ID })).resolves.toBeUndefined();
    expect(queryClient.getQueryData(noteOptions(NOTE_ID).queryKey)).toEqual({ note });
    expect(sent[0]?.variables).toEqual({ id: NOTE_ID });
  });

  it('note: a missing note is not found', async () => {
    stubApi({ note: null });
    const error = await loaderOf(NoteRoute)
      .load({ noteId: NOTE_ID })
      .catch((err: unknown) => err);
    expect(isNotFound(error)).toBe(true);
  });

  it('note: an id that is not a UUID is not found, without asking the API', async () => {
    const sent = stubApi({ note: null });
    const error = await loaderOf(NoteRoute)
      .load({ noteId: 'nope' })
      .catch((err: unknown) => err);
    expect(isNotFound(error)).toBe(true);
    expect(sent).toEqual([]);
  });
});

describe('the note route', () => {
  it('takes the page title from the note the loader cached', async () => {
    const head: unknown = Reflect.get(NoteRoute.options, 'head');
    if (typeof head !== 'function') throw new Error('the note route has no head()');
    const { queryClient } = getRouter().options.context;
    const metaOf = async () => {
      const { meta } = await head({
        match: { context: { queryClient } },
        params: { noteId: NOTE_ID },
      });
      return meta;
    };
    expect(await metaOf()).toEqual([{ title: 'Note not found · acme-app' }]);
    queryClient.setQueryData(noteOptions(NOTE_ID).queryKey, {
      note: { id: NOTE_ID, title: 'Hello', body: '', createdAt: '', commentCount: 0, comments: [] },
    });
    expect(await metaOf()).toEqual([{ title: 'Hello · acme-app' }]);
  });
});
