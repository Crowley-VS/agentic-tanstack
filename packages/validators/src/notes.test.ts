import { describe, expect, it } from 'vitest';
import { CommentInput, NOTE_LIMITS, NoteInput } from './notes';

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

  it('rejects an invalid note id', () => {
    expect(CommentInput.safeParse({ noteId: 'nope', body: 'x' }).success).toBe(false);
  });
});
