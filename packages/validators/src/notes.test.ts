import { describe, expect, it } from 'vitest';
import { CommentInput, NOTE_LIMITS, NoteId, NoteInput, PageArgs } from './notes';

describe('NoteInput', () => {
  it('trims and accepts a valid note', () => {
    expect(NoteInput.parse({ title: '  Hello ', body: 'World' })).toEqual({
      title: 'Hello',
      body: 'World',
    });
  });

  it('rejects a whitespace-only title with a field message', () => {
    const result = NoteInput.safeParse({ title: '   ', body: 'x' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['title'],
      message: 'Title is required',
    });
  });

  it('rejects an over-long body', () => {
    const result = NoteInput.safeParse({ title: 't', body: 'x'.repeat(NOTE_LIMITS.bodyMax + 1) });
    expect(result.success).toBe(false);
  });
});

describe('CommentInput', () => {
  it('treats an empty author name as anonymous', () => {
    const parsed = CommentInput.parse({
      noteId: '0198f3c0-0000-7000-8000-000000000000',
      authorName: '  ',
      body: 'Nice',
    });
    expect(parsed.authorName).toBeUndefined();
  });

  it('treats a null author name as anonymous', () => {
    const parsed = CommentInput.parse({
      noteId: '0198f3c0-0000-7000-8000-000000000000',
      authorName: null,
      body: 'Nice',
    });
    expect(parsed.authorName).toBeUndefined();
  });

  it('rejects an invalid note id', () => {
    expect(CommentInput.safeParse({ noteId: 'nope', body: 'x' }).success).toBe(false);
  });
});

const NOTE_ID = '0198f3c0-0000-7000-8000-000000000000';

describe('NoteId', () => {
  it('accepts a UUID (the database makes v7 ones) and rejects anything else', () => {
    expect(NoteId.safeParse(NOTE_ID).success).toBe(true);
    for (const id of ['nope', '', `${NOTE_ID}x`, NOTE_ID.replaceAll('-', '')])
      expect(NoteId.safeParse(id).error?.issues[0]?.message, id).toBe('Invalid note id');
  });
});

describe('length limits', () => {
  it.each([
    [
      'NoteInput.title',
      NOTE_LIMITS.titleMax,
      (v: string) => NoteInput.safeParse({ title: v, body: 'b' }),
    ],
    [
      'NoteInput.body',
      NOTE_LIMITS.bodyMax,
      (v: string) => NoteInput.safeParse({ title: 't', body: v }),
    ],
    [
      'CommentInput.authorName',
      NOTE_LIMITS.authorNameMax,
      (v: string) => CommentInput.safeParse({ noteId: NOTE_ID, authorName: v, body: 'b' }),
    ],
    [
      'CommentInput.body',
      NOTE_LIMITS.commentBodyMax,
      (v: string) => CommentInput.safeParse({ noteId: NOTE_ID, body: v }),
    ],
  ])('%s accepts %i characters and rejects one more', (_, max, parse) => {
    expect(parse('x'.repeat(max)).success).toBe(true);
    const over = parse('x'.repeat(max + 1));
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.message).toBe(`Must be at most ${max} characters`);
  });

  it('keeps the limits the web UI and the API share', () => {
    expect(NOTE_LIMITS).toEqual({
      titleMax: 120,
      bodyMax: 5000,
      authorNameMax: 40,
      commentBodyMax: 1000,
      pageSize: 20,
      pageSizeMax: 50,
    });
  });

  it('requires a comment body', () => {
    const result = CommentInput.safeParse({ noteId: NOTE_ID, body: '  ' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['body'],
      message: 'Comment is required',
    });
    expect(CommentInput.safeParse({ noteId: NOTE_ID }).success).toBe(false);
  });
});

describe('PageArgs', () => {
  it('defaults to pageSize and accepts 1 to pageSizeMax', () => {
    expect(PageArgs.parse({})).toEqual({ first: NOTE_LIMITS.pageSize });
    expect(PageArgs.parse({ first: 1 })).toEqual({ first: 1 });
    expect(PageArgs.parse({ first: NOTE_LIMITS.pageSizeMax })).toEqual({ first: 50 });
  });

  it.each([0, -1, NOTE_LIMITS.pageSizeMax + 1, 1.5, '10'])('rejects first = %j', (first) => {
    expect(PageArgs.safeParse({ first }).success).toBe(false);
  });
});
