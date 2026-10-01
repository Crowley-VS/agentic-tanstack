// The board: every note, newest first, a page at a time ("Load more"). The loader fills the first
// page during SSR (it is in the HTML); the component reads the same infinite query, and "Load
// more" fetches the next page through the BFF.
import { Button } from '@acme/ui/components/button';
import { Skeleton } from '@acme/ui/components/skeleton';
import { useSuspenseInfiniteQuery } from '@tanstack/react-query';
import { createFileRoute, useHydrated } from '@tanstack/react-router';
import { NoteCard } from '../components/note-card';
import { notesOptions } from '../lib/notes/queries';

export const Route = createFileRoute('/')({
  // awaited, so SSR renders the notes; returns nothing (the dehydrated query cache carries them)
  loader: async ({ context }) => {
    await context.queryClient.ensureInfiniteQueryData(notesOptions());
  },
  head: () => ({ meta: [{ title: 'Notes · acme-app' }] }),
  // a client-side navigation whose loader is slow
  pendingComponent: () => <Skeleton className="h-48 rounded-xl" />,
  component: Board,
});

function Board() {
  const {
    data,
    hasNextPage,
    fetchNextPage,
    fetchStatus,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useSuspenseInfiniteQuery(notesOptions());
  // a click before hydration would be lost: the button waits for React
  const hydrated = useHydrated();
  const notes = data.pages.flatMap((page) => page.notes.edges.map((edge) => edge.node));
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Notes</h1>
      <section aria-label="All notes" className="flex flex-col gap-3">
        {notes.length === 0 ? (
          <p className="text-muted-foreground">No notes yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {notes.map((note) => (
              <li key={note.id}>
                <NoteCard note={note} />
              </li>
            ))}
          </ul>
        )}
        {isFetchNextPageError && (
          <p role="alert" className="text-sm text-destructive">
            Could not load more notes. Try again.
          </p>
        )}
        {hasNextPage && (
          <Button
            type="button"
            variant="outline"
            className="self-center"
            // also while any fetch runs or waits: offline, React Query pauses it ('paused', not
            // 'fetching'), and the button must not look ready while nothing loads
            disabled={!hydrated || fetchStatus !== 'idle'}
            aria-busy={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
          >
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        )}
      </section>
    </>
  );
}
