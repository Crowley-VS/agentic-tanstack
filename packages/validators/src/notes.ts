import * as z from 'zod';

/** Limits shared by the API (validation) and the web UI (input maxLength). */
export const NOTE_LIMITS = {
  titleMax: 120,
  bodyMax: 5000,
  authorNameMax: 40,
  commentBodyMax: 1000,
  pageSizeMax: 50,
} as const;

const trimmed = (min: number, max: number, requiredMessage: string) =>
  z
    .string()
    .trim()
    .min(min, { error: requiredMessage })
    .max(max, { error: `Must be at most ${max} characters` });

export const NoteInput = z.object({
  title: trimmed(1, NOTE_LIMITS.titleMax, 'Title is required'),
  body: trimmed(1, NOTE_LIMITS.bodyMax, 'Body is required'),
});
export type NoteInput = z.infer<typeof NoteInput>;

export const CommentInput = z.object({
  noteId: z.uuid({ error: 'Invalid note id' }),
  authorName: z
    .string()
    .trim()
    .max(NOTE_LIMITS.authorNameMax, {
      error: `Must be at most ${NOTE_LIMITS.authorNameMax} characters`,
    })
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  body: trimmed(1, NOTE_LIMITS.commentBodyMax, 'Comment is required'),
});
export type CommentInput = z.infer<typeof CommentInput>;

export const PageArgs = z.object({
  first: z.number().int().min(1).max(NOTE_LIMITS.pageSizeMax).default(20),
});
