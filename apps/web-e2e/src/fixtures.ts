// Shared helpers for the specs. Every spec runs against one e2e database that other workers,
// spec files (parallel e2e-ci tasks) and retries write to at the same time: assert only on rows the
// test created itself (`uniqueTitle()`), or on the seed, which no spec changes (docs/e2e.md).
// Against a stack started elsewhere (BASE_URL mode) the seed and the private API may be out of
// reach: the specs that need them skip (`NEEDS_SEED`, the `apiURL` fixture).
import { randomUUID } from 'node:crypto';
import {
  type APIRequestContext,
  test as base,
  expect,
  type Locator,
  type Page,
} from '@playwright/test';

export { expect };

/** The deterministic seed (packages/db/src/seed.ts, which this project may not import). */
export const SEED = {
  notes: 25,
  /** Oldest first: "Seed note 01" … "Seed note 25"; note n has n % 4 comments. */
  title: (n: number) => `Seed note ${String(n).padStart(2, '0')}`,
  comments: (n: number) => n % 4,
} as const;

/** Why a spec that reads the seed skips: BASE_URL mode on a database not seeded for e2e. */
export const NEEDS_SEED = 'needs the e2e seed: BASE_URL mode without E2E_SEEDED=1 (docs/e2e.md)';

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

/**
 * Click "Load more" on the board until `target` shows. Other specs add notes meanwhile (newest
 * first), so the number of pages is not fixed: one page per click, waiting for it to land.
 */
export async function showOnBoard(page: Page, target: Locator) {
  const notes = page.getByRole('region', { name: 'All notes' }).getByRole('listitem');
  const loadMore = page.getByRole('button', { name: 'Load more' });
  await expect(notes.first()).toBeVisible();
  await expect(async () => {
    if (await target.isVisible()) return;
    const shown = await notes.count();
    await loadMore.click({ timeout: 5000 }); // enabled once hydrated and the last page is in
    await expect.poll(() => notes.count()).toBeGreaterThan(shown);
    // checks once: an expect timeout of 0 would wait forever, so toPass would never load another page
    expect(await target.isVisible()).toBe(true);
  }).toPass();
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

/** What the stack under test offers: set by playwright.config.mts (`use`), read as fixtures. */
export type StackOptions = {
  /** The private API's address; undefined when it is out of reach (BASE_URL mode, no API_URL). */
  apiURL: string | undefined;
  /** The database holds the seed (`SEED`); false in BASE_URL mode without E2E_SEEDED=1. */
  seeded: boolean;
};

export const test = base.extend<
  {
    /** Create a note through the BFF (a unique title unless given); returns it. */
    createNote: (input?: { title?: string; body?: string }) => Promise<CreatedNote>;
  },
  StackOptions
>({
  apiURL: [undefined, { option: true, scope: 'worker' }],
  seeded: [true, { option: true, scope: 'worker' }],
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
