// One note on the board: its title (the link to the note), the start of its body, when it was
// written and how many comments it has. Plain text only; long words wrap instead of overflowing.
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@acme/ui/components/card';
import { Link } from '@tanstack/react-router';
import { commentCountLabel, excerpt, formatTimestamp } from '../lib/notes/format';

export type NoteSummary = {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  commentCount: number;
};

export function NoteCard({ note }: { note: NoteSummary }) {
  return (
    <Card size="sm" className="relative">
      <CardHeader>
        <CardTitle className="wrap-anywhere">
          {/* the link covers the card (after:absolute), so the whole card is clickable */}
          <Link
            to="/notes/$noteId"
            params={{ noteId: note.id }}
            className="after:absolute after:inset-0 hover:underline"
          >
            {note.title}
          </Link>
        </CardTitle>
        <CardDescription>
          <time dateTime={note.createdAt}>{formatTimestamp(note.createdAt)}</time> ·{' '}
          {commentCountLabel(note.commentCount)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="wrap-anywhere text-muted-foreground">{excerpt(note.body)}</p>
      </CardContent>
    </Card>
  );
}
