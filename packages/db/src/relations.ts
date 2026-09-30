import { defineRelations } from 'drizzle-orm';
import * as schema from './schema';

export const relations = defineRelations(schema, (r) => ({
  notes: {
    comments: r.many.comments(),
  },
  comments: {
    note: r.one.notes({ from: r.comments.noteId, to: r.notes.id, optional: false }),
  },
}));

export type Relations = typeof relations;
