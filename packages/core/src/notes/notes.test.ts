import { testDb } from '@acme/db/testing';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { NotFoundError } from '../errors';
import { addComment, createNote } from './index';

describe('createNote', () => {
  it('trims and stores a valid note', async () => {
    const { db } = testDb();
    const note = await createNote(db, { title: '  Groceries ', body: 'Milk' });
    expect(note).toMatchObject({ title: 'Groceries', body: 'Milk' });
    expect(note.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('stores a trimmed source URL, and none for a blank or missing one', async () => {
    const { db } = testDb();
    const linked = await createNote(db, { title: 'T', body: 'B', sourceUrl: ' https://x.co/a ' });
    expect(linked.sourceUrl).toBe('https://x.co/a');
    for (const sourceUrl of ['  ', null, undefined])
      expect((await createNote(db, { title: 'T', body: 'B', sourceUrl })).sourceUrl).toBeNull();
  });

  it('rejects a source URL that is not http or https without writing anything', async () => {
    const { db } = testDb();
    const before = (await db.query.notes.findMany()).length;
    await expect(
      createNote(db, { title: 'T', body: 'B', sourceUrl: 'javascript:alert(1)' }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(await db.query.notes.findMany()).toHaveLength(before);
  });

  it('rejects a whitespace-only title without writing anything', async () => {
    const { db } = testDb();
    // tests in a file share its database: compare counts, never assume it is empty
    const before = (await db.query.notes.findMany()).length;
    await expect(createNote(db, { title: '   ', body: 'x' })).rejects.toBeInstanceOf(ZodError);
    expect(await db.query.notes.findMany()).toHaveLength(before);
  });
});

describe('addComment', () => {
  it('adds a comment, treating a blank author as anonymous', async () => {
    const { db } = testDb();
    const note = await createNote(db, { title: 'T', body: 'B' });
    const comment = await addComment(db, { noteId: note.id, authorName: ' ', body: 'Nice' });
    expect(comment).toMatchObject({ noteId: note.id, authorName: null, body: 'Nice' });
  });

  it('throws NotFoundError for a missing note, in one statement', async () => {
    const { db, statements } = testDb();
    statements.length = 0;
    const missing = '0198f3c0-0000-7000-8000-000000000000';
    const err = await addComment(db, { noteId: missing, body: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toMatchObject({ entity: 'Note', id: missing });
    expect(statements).toHaveLength(1);
  });
});
