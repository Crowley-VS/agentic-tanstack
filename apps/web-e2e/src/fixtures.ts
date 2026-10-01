// Shared helpers for the specs. Every spec runs against one e2e database that other workers,
// spec files (parallel e2e-ci tasks) and retries write to at the same time: assert only on rows the
// test created itself (`uniqueTitle()`), or on the seed, which no spec changes (docs/e2e.md).
import { randomUUID } from 'node:crypto';
import { type APIRequestContext, test as base, expect } from '@playwright/test';

export { expect };

/** The deterministic seed (packages/db/src/seed.ts, which this project may not import). */
export const SEED = {
  notes: 25,
  /** Oldest first: "Seed note 01" … "Seed note 25"; note n has n % 4 comments. */
  title: (n: number) => `Seed note ${String(n).padStart(2, '0')}`,
  comments: (n: number) => n % 4,
} as const;

/** A note title no other test, worker, retry or earlier run uses (at most 120 characters). */
export const uniqueTitle = (label: string) => `e2e ${label} ${randomUUID()}`;

type GraphQLResponse<T> = {
  data?: T;
  errors?: { message: string; extensions?: Record<string, unknown> }[];
};

/**
 * POST a GraphQL operation to the web's BFF (`/api/graphql`), as the browser does, and return its
 * `data`; fails the test on top-level errors. Expected failures are data (`__typename`).
 */
export async function gql<T>(
  request: APIRequestContext,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await request.post('/api/graphql', { data: { query, variables } });
  const { data, errors }: GraphQLResponse<T> = await response.json();
  expect(errors, `GraphQL errors (HTTP ${response.status()})`).toBeUndefined();
  expect(response.ok()).toBe(true);
  if (data == null) throw new Error(`GraphQL answered without data (HTTP ${response.status()})`);
  return data;
}

export type CreatedNote = { id: string; title: string; body: string };

const CreateNote = /* GraphQL */ `
  mutation E2ECreateNote($input: CreateNoteInput!) {
    createNote(input: $input) {
      __typename
      ... on MutationCreateNoteSuccess {
        data {
          id
          title
          body
        }
      }
    }
  }
`;

export const test = base.extend<{
  /** Create a note through the BFF (a unique title unless given); returns it. */
  createNote: (input?: { title?: string; body?: string }) => Promise<CreatedNote>;
}>({
  createNote: async ({ request }, use) => {
    await use(async ({ title = uniqueTitle('note'), body = 'Created by an e2e test.' } = {}) => {
      const { createNote } = await gql<{
        createNote: { __typename: string; data?: CreatedNote };
      }>(request, CreateNote, { input: { title, body } });
      expect(createNote).toMatchObject({ __typename: 'MutationCreateNoteSuccess' });
      if (!createNote.data) throw new Error('createNote returned no note');
      return createNote.data;
    });
  },
});
