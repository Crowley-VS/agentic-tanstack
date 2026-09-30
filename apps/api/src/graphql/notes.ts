// The Notes board: a public, create-only board of notes with comments. Reads go through the
// Drizzle plugin (a nested query, counts included, is planned as one SQL statement); writes go
// through @acme/core, validated here first with the same Zod schemas (@acme/validators), so core's
// own validation never fails for input that got this far.
import { NotFoundError } from '@acme/core/errors';
import { addComment, createNote } from '@acme/core/notes';
import { CommentInput, NOTE_LIMITS, NoteInput } from '@acme/validators/notes';
import { z } from 'zod';
import { builder } from './builder';
import { ValidationError } from './errors';

const newestFirst = { createdAt: 'desc', id: 'desc' } as const;

/** The comments a note shows (the newest); `commentCount` has the total. */
export const COMMENTS_SHOWN = 50;

const Note = builder.drizzleObject('notes', {
  name: 'Note',
  fields: (t) => ({
    id: t.exposeID('id'),
    title: t.exposeString('title'),
    body: t.exposeString('body'),
    createdAt: t.expose('createdAt', { type: 'DateTime' }),
    comments: t.relation('comments', {
      description: `The newest ${COMMENTS_SHOWN} comments, newest first`,
      query: { limit: COMMENTS_SHOWN, orderBy: newestFirst },
      // priced by the rows it can return (the default list multiplier is 10)
      complexity: { field: 1, multiplier: COMMENTS_SHOWN },
    }),
    commentCount: t.relatedCount('comments'),
  }),
});

const Comment = builder.drizzleObject('comments', {
  name: 'Comment',
  fields: (t) => ({
    id: t.exposeID('id'),
    authorName: t.exposeString('authorName', { nullable: true }),
    body: t.exposeString('body'),
    createdAt: t.expose('createdAt', { type: 'DateTime' }),
    note: t.relation('note'),
  }),
});

builder.queryFields((t) => ({
  notes: t.drizzleConnection(
    {
      type: 'notes',
      description: 'Every note, newest first',
      // priced by the page size asked for (the plugin caps pages at NOTE_LIMITS.pageSizeMax)
      complexity: (args) => ({
        field: 1,
        multiplier: Math.min(args.first ?? args.last ?? 20, NOTE_LIMITS.pageSizeMax),
      }),
      resolve: (query, _root, _args, ctx) =>
        ctx.db.query.notes.findMany(query({ orderBy: newestFirst })),
    },
    // the page size above already counts the rows: the edges must not multiply again by the
    // default list multiplier
    { edgesField: { complexity: { field: 1, multiplier: 1 } } },
  ),
  note: t.drizzleField({
    type: 'notes',
    nullable: true,
    args: { id: t.arg.id({ required: true, validate: z.uuid({ error: 'Invalid note id' }) }) },
    resolve: (query, _root, { id }, ctx) => ctx.db.query.notes.findFirst(query({ where: { id } })),
  }),
}));

const CreateNoteInput = builder.inputType('CreateNoteInput', {
  fields: (t) => ({
    title: t.string({ required: true }),
    body: t.string({ required: true }),
  }),
});

const AddCommentInput = builder.inputType('AddCommentInput', {
  fields: (t) => ({
    noteId: t.id({ required: true }),
    authorName: t.string({ description: 'Shown as "Anonymous" when left out or blank' }),
    body: t.string({ required: true }),
  }),
});

builder.mutationFields((t) => ({
  createNote: t.field({
    type: Note,
    args: { input: t.arg({ type: CreateNoteInput, required: true, validate: NoteInput }) },
    errors: { types: [ValidationError] },
    resolve: (_root, { input }, ctx) => createNote(ctx.db, input),
  }),
  addComment: t.field({
    type: Comment,
    args: { input: t.arg({ type: AddCommentInput, required: true, validate: CommentInput }) },
    errors: { types: [ValidationError, NotFoundError] },
    resolve: (_root, { input }, ctx) => addComment(ctx.db, input),
  }),
}));
