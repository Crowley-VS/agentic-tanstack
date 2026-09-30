import { comments, notes, type Comment, type Db, type Note } from '@acme/db';
import { CommentInput, NoteInput } from '@acme/validators/notes';
import { NotFoundError, pgErrorCode, PG_FOREIGN_KEY_VIOLATION } from '../errors';

// Writes live here; reads go through the API's Drizzle plugin (it plans nested reads as one query).
// Inputs are validated again even though the API validates them: core is callable from anywhere.

/** Create a note. Throws a ZodError for invalid input. */
export async function createNote(db: Db, input: unknown): Promise<Note> {
  const values = NoteInput.parse(input);
  const [note] = await db.insert(notes).values(values).returning();
  if (!note) throw new Error('createNote: insert returned no row');
  return note;
}

/** Add a comment to a note. Throws a ZodError for invalid input, NotFoundError for a missing note. */
export async function addComment(db: Db, input: unknown): Promise<Comment> {
  const values = CommentInput.parse(input);
  try {
    const [comment] = await db.insert(comments).values(values).returning();
    if (!comment) throw new Error('addComment: insert returned no row');
    return comment;
  } catch (err) {
    // One statement instead of check-then-insert: the foreign key is the source of truth.
    if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION)
      throw new NotFoundError('Note', values.noteId);
    throw err;
  }
}
