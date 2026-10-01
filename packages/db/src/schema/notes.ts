import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Timestamps use precision 3 (milliseconds): a JS Date round-trips exactly, so cursor pagination
// on (created_at, id) never skips rows (microsecond precision silently breaks page 2).
const createdAt = () =>
  timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow();

// Ids: Postgres 18's time-ordered uuidv7().
export const notes = pgTable(
  'notes',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** Where the note came from: an http(s) URL, or null (notes written before it had none). */
    sourceUrl: text('source_url'),
    createdAt: createdAt(),
  },
  // Ascending on purpose: Postgres scans it backwards for `ORDER BY created_at DESC, id DESC`,
  // while drizzle's .desc() would emit DESC NULLS LAST, which that ORDER BY cannot use.
  (t) => [index('notes_created_at_id_idx').on(t.createdAt, t.id)],
);

export const comments = pgTable(
  'comments',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    noteId: uuid('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    authorName: text('author_name'),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  // also serves the foreign key and per-note comment counts
  (t) => [index('comments_note_id_created_at_idx').on(t.noteId, t.createdAt)],
);

export type Note = typeof notes.$inferSelect;
export type Comment = typeof comments.$inferSelect;
