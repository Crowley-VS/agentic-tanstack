// The board and the note page in real Chromium. The board's "Load more" appends the next page,
// stays disabled while a page loads (offline too), and says when one fails; the note page says
// when it shows only the newest comments. The loaders: router.test.ts; the server-rendered pages
// and their hydration: web-e2e (board.spec.ts). Test files stay out of src/routes (the route
// generator reads it).
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  type AnyRoute,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type { NoteQuery, NotesQuery } from './gql/graphql';
import { appStatusOptions } from './lib/app-status';
import { noteOptions, notesOptions } from './lib/notes/queries';
import { Route as BoardRoute } from './routes/index';
import { Route as NoteRoute } from './routes/notes/$noteId';

// execute()'s transport is a Start isomorphic function, which needs Start's Vite plugin
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('./lib/graphql/execute', () => ({ execute }));

afterEach(() => {
  onlineManager.setOnline(true);
  vi.resetAllMocks();
});

/**
 * A route's component at `url`, in a small in-memory router (its links need one) with the route's
 * `path`, over a query cache filled as the loaders leave it (the root's app status, writable, for
 * the page's form). Loaders do not run here (router.test.ts covers them), and file routes get
 * their path from routeTree.gen.ts.
 */
async function renderRoute(
  route: AnyRoute,
  path: string,
  url: string,
  fill: (cache: QueryClient) => void,
) {
  const { component } = route.options;
  if (!component) throw new Error(`${path} has no component`);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: false } },
  });
  queryClient.setQueryData(appStatusOptions().queryKey, { readOnly: false });
  fill(queryClient);
  const root = createRootRoute();
  const router = createRouter({
    routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path, component })]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('Board (browser)', () => {
  const title = (n: number) => `Note ${String(n).padStart(2, '0')}`;

  /** One page of the Notes query: notes `newest` down to `oldest`. */
  function page(newest: number, oldest: number, hasNextPage: boolean): NotesQuery {
    const numbers = Array.from({ length: newest - oldest + 1 }, (_, i) => newest - i);
    return {
      notes: {
        edges: numbers.map((n) => ({
          node: {
            id: `note-${n}`,
            title: title(n),
            body: `Body ${n}`,
            createdAt: '2026-01-01T09:00:00.000Z',
            commentCount: 0,
          },
        })),
        pageInfo: { hasNextPage, endCursor: `cursor-${oldest}` },
      },
    };
  }

  /** The board with its first page in the cache (by default notes 25 to 6, and more to load). */
  async function renderBoard(first: NotesQuery = page(25, 6, true)) {
    const screen = await renderRoute(BoardRoute, '/', '/', (cache) =>
      cache.setQueryData(notesOptions().queryKey, { pages: [first], pageParams: [null] }),
    );
    await expect.element(screen.getByRole('heading', { name: 'Notes', exact: true })).toBeVisible();
    return {
      screen,
      notes: () => screen.getByRole('listitem').elements(),
      loadMore: screen.getByRole('button', { name: 'Load more', exact: true }),
      oldest: screen.getByText(title(1), { exact: true }),
    };
  }

  it('appends the next page, then hides Load more when there is none', async () => {
    execute.mockResolvedValue(page(5, 1, false));
    const { notes, loadMore, oldest } = await renderBoard();
    expect(notes()).toHaveLength(20);

    await loadMore.click();
    await expect.element(oldest).toBeVisible();
    expect(notes()).toHaveLength(25);
    await expect.element(loadMore).not.toBeInTheDocument();
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      { first: 20, after: 'cursor-6' },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('is disabled and busy while the next page loads', async () => {
    let answer!: (value: NotesQuery) => void;
    execute.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { screen, loadMore, oldest } = await renderBoard();

    await loadMore.click();
    const loading = screen.getByRole('button', { name: 'Loading…', exact: true });
    await expect.element(loading).toBeDisabled();
    await expect.element(loading).toHaveAttribute('aria-busy', 'true');

    answer(page(5, 1, false));
    await expect.element(oldest).toBeVisible();
  });

  it('offline: stays disabled while the fetch waits, and loads once back online', async () => {
    execute.mockResolvedValue(page(5, 1, false));
    const { loadMore, oldest } = await renderBoard();
    onlineManager.setOnline(false);

    await loadMore.click();
    // React Query pauses the fetch ('paused', not 'fetching'): the button must not look ready
    await expect.element(loadMore).toBeDisabled();
    expect(execute).not.toHaveBeenCalled();

    onlineManager.setOnline(true);
    await expect.element(oldest).toBeVisible();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('says when the next page fails, and Load more tries again', async () => {
    execute.mockRejectedValueOnce(new Error('API unavailable'));
    execute.mockResolvedValueOnce(page(5, 1, false));
    const { screen, notes, loadMore, oldest } = await renderBoard();

    await loadMore.click();
    const failed = screen.getByRole('alert');
    await expect.element(failed).toHaveTextContent('Could not load more notes. Try again.');
    expect(notes()).toHaveLength(20);

    await loadMore.click();
    await expect.element(oldest).toBeVisible();
    await expect.element(failed).not.toBeInTheDocument();
  });

  it('says so when there are no notes, with nothing to load', async () => {
    const { screen, loadMore } = await renderBoard({
      notes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    await expect.element(screen.getByText('No notes yet.', { exact: true })).toBeVisible();
    await expect.element(loadMore).not.toBeInTheDocument();
  });
});

describe('NotePage (browser)', () => {
  const ID = '0198f3c0-0000-7000-8000-000000000000';

  /** The note page for a note with `count` comments, `shown` of them in the answer. */
  async function renderNote(count: number, shown: number, sourceUrl: string | null = null) {
    const note: NonNullable<NoteQuery['note']> = {
      id: ID,
      title: 'A note',
      body: 'Its body.',
      sourceUrl,
      createdAt: '2026-01-01T09:00:00.000Z',
      commentCount: count,
      comments: Array.from({ length: shown }, (_, i) => ({
        id: `comment-${i}`,
        authorName: i === 0 ? null : `Reader ${i}`,
        body: `Comment ${i}`,
        createdAt: '2026-01-01T09:00:00.000Z',
      })),
    };
    const screen = await renderRoute(NoteRoute, '/notes/$noteId', `/notes/${ID}`, (cache) =>
      cache.setQueryData(noteOptions(ID).queryKey, { note }),
    );
    await expect
      .element(screen.getByRole('heading', { name: 'A note', exact: true }))
      .toBeVisible();
    return {
      screen,
      comments: screen.getByRole('region', { name: `${count} comments`, exact: true }),
    };
  }

  it('shows every comment with the count, a missing name as "Anonymous"', async () => {
    const { screen, comments } = await renderNote(3, 3);
    expect(comments.getByRole('listitem').elements()).toHaveLength(3);
    await expect.element(comments.getByRole('listitem').first()).toHaveTextContent(/^Anonymous/);
    expect(screen.getByText(/^Showing the newest/).elements()).toEqual([]);
  });

  it('links its source, in a new tab that cannot reach this page', async () => {
    const { screen } = await renderNote(0, 0, 'https://example.com/post?id=1');
    const source = screen.getByRole('link', { name: 'Source', exact: true });
    await expect.element(source).toHaveAttribute('href', 'https://example.com/post?id=1');
    await expect.element(source).toHaveAttribute('target', '_blank');
    await expect.element(source).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('shows no source link without a source, or for one that is not http(s)', async () => {
    for (const sourceUrl of [null, 'javascript:alert(1)']) {
      const { screen } = await renderNote(0, 0, sourceUrl);
      expect(screen.getByRole('link', { name: 'Source' }).elements()).toEqual([]);
      await screen.unmount();
    }
  });

  it('says when it shows only the newest comments', async () => {
    const { comments } = await renderNote(60, 50);
    expect(comments.getByRole('listitem').elements()).toHaveLength(50);
    await expect
      .element(comments.getByText('Showing the newest 50 of 60.', { exact: true }))
      .toBeVisible();
  });
});
