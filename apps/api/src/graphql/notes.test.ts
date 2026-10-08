// The Notes API end to end through `yoga.fetch`, against this test file's own Postgres database.
// Rows other tests in this file create are expected: assertions look only at their own.
import { notes } from '@acme/db';
import { testDb } from '@acme/db/testing';
import { READ_ONLY } from '@acme/validators/error-codes';
import { NOTE_LIMITS } from '@acme/validators/notes';
import { count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { loadEnv } from '../env';

const { db, statements } = testDb();
const env = (extra: Record<string, string> = {}) =>
  loadEnv({ DATABASE_URL: 'postgres://127.0.0.1/unused', ...extra });
const app = createApp({ db, env: env() });

type Result = { data?: Record<string, any>; errors?: { message: string; extensions?: any }[] };
async function gql(
  source: string,
  variables: Record<string, unknown> = {},
  target = app,
): Promise<Result> {
  const res = await target.fetch('http://api/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: source, variables }),
  });
  return (await res.json()) as Result;
}

const CREATE_NOTE = /* GraphQL */ `
  mutation ($input: CreateNoteInput!) {
    createNote(input: $input) {
      __typename
      ... on MutationCreateNoteSuccess {
        data {
          id
          title
          body
          commentCount
        }
      }
      ... on ValidationError {
        message
        fieldErrors {
          path
          message
        }
      }
    }
  }
`;
const ADD_COMMENT = /* GraphQL */ `
  mutation ($input: AddCommentInput!) {
    addComment(input: $input) {
      __typename
      ... on MutationAddCommentSuccess {
        data {
          id
          authorName
          body
          note {
            id
          }
        }
      }
      ... on ValidationError {
        fieldErrors {
          path
          message
        }
      }
      ... on NotFoundError {
        entity
        id
        message
      }
    }
  }
`;

async function newNote(title: string, body = 'body') {
  const { data } = await gql(CREATE_NOTE, { input: { title, body } });
  return data?.createNote.data as { id: string; title: string };
}

describe('mutations', () => {
  it('creates a note through core, trimmed', async () => {
    const { data } = await gql(CREATE_NOTE, { input: { title: '  Groceries ', body: 'milk' } });
    expect(data?.createNote).toMatchObject({
      __typename: 'MutationCreateNoteSuccess',
      data: { title: 'Groceries', body: 'milk', commentCount: 0 },
    });
    const [row] = await db.select().from(notes).where(eq(notes.id, data?.createNote.data.id));
    expect(row?.title).toBe('Groceries');
  });

  it('returns invalid input as a ValidationError, field by field, and writes nothing', async () => {
    const [before] = await db.select({ n: count() }).from(notes);
    const { data } = await gql(CREATE_NOTE, { input: { title: '   ', body: 'x'.repeat(5001) } });
    expect(data?.createNote).toEqual({
      __typename: 'ValidationError',
      message: 'Invalid input: Title is required; Must be at most 5000 characters',
      fieldErrors: [
        { path: ['input', 'title'], message: 'Title is required' },
        { path: ['input', 'body'], message: 'Must be at most 5000 characters' },
      ],
    });
    const [after] = await db.select({ n: count() }).from(notes);
    expect(after?.n).toBe(before?.n);
  });

  it('adds a comment, anonymous when the name is blank', async () => {
    const note = await newNote('Commented');
    const { data } = await gql(ADD_COMMENT, {
      input: { noteId: note.id, authorName: '  ', body: ' First! ' },
    });
    expect(data?.addComment).toMatchObject({
      __typename: 'MutationAddCommentSuccess',
      data: { authorName: null, body: 'First!', note: { id: note.id } },
    });
  });

  it('adds a comment, anonymous when the name is null', async () => {
    const note = await newNote('Null name');
    const { data } = await gql(ADD_COMMENT, {
      input: { noteId: note.id, authorName: null, body: 'Hi' },
    });
    expect(data?.addComment).toMatchObject({
      __typename: 'MutationAddCommentSuccess',
      data: { authorName: null, body: 'Hi', note: { id: note.id } },
    });
  });

  it('returns a comment on a missing note as a NotFoundError', async () => {
    const id = '0199aa00-0000-7000-8000-000000000000';
    const { data } = await gql(ADD_COMMENT, { input: { noteId: id, body: 'hello?' } });
    expect(data?.addComment).toEqual({
      __typename: 'NotFoundError',
      entity: 'Note',
      id,
      message: `Note ${id} not found`,
    });
  });

  it('rejects a malformed note id as invalid input', async () => {
    const { data } = await gql(ADD_COMMENT, { input: { noteId: 'nope', body: 'hi' } });
    expect(data?.addComment).toEqual({
      __typename: 'ValidationError',
      fieldErrors: [{ path: ['input', 'noteId'], message: 'Invalid note id' }],
    });
  });

  it('rejects every mutation, and nothing else, when READ_ONLY is on', async () => {
    const readOnly = createApp({ db, env: env({ READ_ONLY: 'true' }) });
    const [before] = await db.select({ n: count() }).from(notes);
    const created = await gql(CREATE_NOTE, { input: { title: 'Nope', body: 'x' } }, readOnly);
    expect(created.data).toBeUndefined();
    expect(created.errors?.[0]?.extensions?.code).toBe(READ_ONLY);
    const [after] = await db.select({ n: count() }).from(notes);
    expect(after?.n).toBe(before?.n);
    expect((await gql('{ notes(first: 1) { edges { cursor } } }', {}, readOnly)).errors).toBe(
      undefined,
    );
  });

  it('tells clients whether it accepts writes (Query.readOnly), so forms can be disabled', async () => {
    expect(await gql('{ readOnly }')).toEqual({ data: { readOnly: false } });
    const readOnly = createApp({ db, env: env({ READ_ONLY: 'true' }) });
    expect(await gql('{ readOnly }', {}, readOnly)).toEqual({ data: { readOnly: true } });
  });
});

describe('queries', () => {
  it('pages through every note, newest first, without skipping or repeating one', async () => {
    for (const n of [1, 2, 3, 4, 5]) await newNote(`Paged ${n}`);
    const seen: string[] = [];
    let after: string | null = null;
    for (;;) {
      const { data, errors } = await gql(
        `query ($after: String) { notes(first: 2, after: $after) {
          edges { node { id } } pageInfo { hasNextPage endCursor } } }`,
        { after },
      );
      expect(errors).toBeUndefined();
      seen.push(...data?.notes.edges.map((e: { node: { id: string } }) => e.node.id));
      if (!data?.notes.pageInfo.hasNextPage) break;
      after = data.notes.pageInfo.endCursor;
    }
    const expected = await db.query.notes.findMany({
      columns: { id: true },
      orderBy: { createdAt: 'desc', id: 'desc' },
    });
    expect(seen).toEqual(expected.map((n) => n.id));
  });

  it('caps a page at the shared limit, and serves the shared page size by default', async () => {
    await db
      .insert(notes)
      .values(Array.from({ length: 55 }, (_, n) => ({ title: `Bulk ${n}`, body: 'x' })));
    const { data, errors } = await gql('{ notes(first: 51) { edges { cursor } } }');
    expect(errors).toBeUndefined();
    expect(data?.notes.edges).toHaveLength(NOTE_LIMITS.pageSizeMax);
    const unsized = await gql('{ notes { edges { cursor } } }');
    expect(unsized.data?.notes.edges).toHaveLength(NOTE_LIMITS.pageSize);
  });

  it('reads one note with its newest comments and their total', async () => {
    const note = await newNote('With comments');
    for (const body of ['one', 'two', 'three'])
      await gql(ADD_COMMENT, { input: { noteId: note.id, body } });
    const { data } = await gql(
      'query ($id: ID!) { note(id: $id) { title commentCount comments { body } } }',
      { id: note.id },
    );
    expect(data?.note).toEqual({
      title: 'With comments',
      commentCount: 3,
      comments: [{ body: 'three' }, { body: 'two' }, { body: 'one' }],
    });
    const missing = await gql('{ note(id: "0199aa00-0000-7000-8000-000000000001") { id } }');
    expect(missing).toEqual({ data: { note: null } });
    // not masked like an unexpected error: the client learns what to fix
    const [invalid] = (await gql('{ note(id: "nope") { id } }')).errors ?? [];
    expect(invalid?.message).toBe('Invalid input: Invalid note id');
    expect(invalid?.extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('reads a page of notes with their comments and counts in one SQL statement (no N+1)', async () => {
    for (const n of [1, 2, 3]) {
      const note = await newNote(`N+1 ${n}`);
      for (const body of ['a', 'b']) await gql(ADD_COMMENT, { input: { noteId: note.id, body } });
    }
    statements.length = 0;
    const { data, errors } = await gql(`{ notes(first: 10) { edges { node {
      title commentCount comments { body authorName } } } } }`);
    // one relational query for the whole page, however many notes and comments it holds
    expect(statements).toHaveLength(1);
    expect(errors).toBeUndefined();
    const withComments = data?.notes.edges.filter(
      (e: { node: { commentCount: number } }) => e.node.commentCount > 0,
    );
    expect(withComments.length).toBeGreaterThanOrEqual(3);
  });

  it('prices a query by the rows it can return, and rejects one that could return too many', async () => {
    // what the board and a note page ask for: accepted
    const board = await gql(`{ notes(first: 50) { edges { cursor node {
      id title body createdAt commentCount } } pageInfo { hasNextPage endCursor } } }`);
    expect(board.errors).toBeUndefined();
    const page = await gql(
      `query ($id: ID!) { note(id: $id) { id title body createdAt
      commentCount comments { id authorName body createdAt } } }`,
      {
        id: '0199aa00-0000-7000-8000-000000000002',
      },
    );
    expect(page.errors).toBeUndefined();
    // 20 notes with up to 50 comments each (up to 1,000 comments): only a note page lists comments
    const everyComment = await gql(`{ notes(first: 20) { edges { node {
      comments { id authorName body createdAt } } } } }`);
    expect(everyComment.errors?.[0]?.message).toMatch(/complexity/i);
    // without `first` it gets a default page (NOTE_LIMITS.pageSize), so it costs one too
    const unsized = await gql(`{ notes { edges { node {
      comments { id authorName body createdAt } } } } }`);
    expect(unsized.errors?.[0]?.message).toMatch(/complexity/i);
    // 50 notes × 50 comments × their note × 50 comments: rejected before anything runs
    statements.length = 0;
    const nested = await gql(`{ notes(first: 50) { edges { node {
      comments { note { comments { body } } } } } } }`);
    expect(nested.errors?.[0]?.message).toMatch(/complexity/i);
    expect(statements).toHaveLength(0);
  });
});
