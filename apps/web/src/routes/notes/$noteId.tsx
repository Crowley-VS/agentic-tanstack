// One note: its title and body, its newest comments with the total, and the "Add a comment" form.
// An id that is not a UUID, or no note with it, is a 404 (notFound(): SSR answers HTTP 404).
import { Skeleton } from '@acme/ui/components/skeleton';
import { NoteId } from '@acme/validators/notes';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { CommentForm } from '../../components/comment-form';
import { NotFound } from '../../components/not-found';
import { authorName, commentCountLabel, formatTimestamp } from '../../lib/notes/format';
import { noteOptions } from '../../lib/notes/queries';

export const Route = createFileRoute('/notes/$noteId')({
  loader: async ({ context, params: { noteId } }) => {
    // checked here, not by the API: a malformed id is a GraphQL error there, a 404 here
    if (!NoteId.safeParse(noteId).success) throw notFound();
    const { note } = await context.queryClient.ensureQueryData(noteOptions(noteId));
    if (!note) throw notFound();
  },
  // the title comes from the cache the loader filled (loaders return nothing)
  head: ({ match, params }) => {
    const note = match.context.queryClient.getQueryData(noteOptions(params.noteId).queryKey)?.note;
    return { meta: [{ title: `${note?.title ?? 'Note not found'} · acme-app` }] };
  },
  pendingComponent: () => <Skeleton className="h-64 rounded-xl" />,
  notFoundComponent: () => <NotFound>No note has this address.</NotFound>,
  component: NotePage,
});

function NotePage() {
  const { noteId } = Route.useParams();
  const { note } = useSuspenseQuery(noteOptions(noteId)).data;
  if (!note) throw notFound();
  const shown = note.comments.length;
  return (
    <>
      <Link to="/" className="text-sm text-muted-foreground hover:underline">
        ← All notes
      </Link>
      <article className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight wrap-anywhere">{note.title}</h1>
        <p className="text-sm text-muted-foreground">
          <time dateTime={note.createdAt}>{formatTimestamp(note.createdAt)}</time>
        </p>
        <p className="whitespace-pre-wrap wrap-anywhere">{note.body}</p>
      </article>
      <section aria-labelledby="comments" className="flex flex-col gap-3">
        <h2 id="comments" className="text-lg font-semibold">
          {commentCountLabel(note.commentCount)}
        </h2>
        <CommentForm noteId={note.id} />
        {note.commentCount > shown && (
          <p className="text-sm text-muted-foreground">
            Showing the newest {shown} of {note.commentCount}.
          </p>
        )}
        {shown > 0 && (
          <ul className="flex flex-col gap-3">
            {note.comments.map((comment) => (
              <li key={comment.id} className="rounded-lg border p-3 text-sm">
                <p className="font-medium wrap-anywhere">
                  {authorName(comment.authorName)}{' '}
                  <time dateTime={comment.createdAt} className="font-normal text-muted-foreground">
                    {formatTimestamp(comment.createdAt)}
                  </time>
                </p>
                <p className="whitespace-pre-wrap wrap-anywhere">{comment.body}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
