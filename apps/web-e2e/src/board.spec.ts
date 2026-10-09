// The board ("/") and the note page ("/notes/$noteId") in a real browser, against the production
// build. Other specs add notes at the same time and the board is newest first, so seed notes are
// found by title, never by position; tests that need a fresh note create their own.
import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { expect, gql, NEEDS_SEED, SEED, showOnBoard, test, uniqueTitle } from './fixtures';

/** Notes per board page (NOTE_LIMITS.pageSize in @acme/validators). */
const PAGE_SIZE = 20;

/** The id of seed note `n` ("Seed note 03" for 3), from the oldest end of the list. */
async function seedNoteId(request: APIRequestContext, n: number) {
  const { notes } = await gql<{ notes: { edges: { node: { id: string; title: string } }[] } }>(
    request,
    /* GraphQL */ `
      query E2EOldestNoteIds($last: Int!) {
        notes(last: $last) {
          edges {
            node {
              id
              title
            }
          }
        }
      }
    `,
    { last: SEED.notes },
  );
  const id = notes.edges.find((edge) => edge.node.title === SEED.title(n))?.node.id;
  if (!id) throw new Error(`no ${SEED.title(n)} in the e2e database`);
  return id;
}

test.describe('server-rendered (JavaScript off)', () => {
  test.use({ javaScriptEnabled: false });

  test('the board: a page of notes, and Load more disabled until hydration', async ({
    page,
    seeded,
  }) => {
    test.skip(!seeded, NEEDS_SEED); // a full page: at least PAGE_SIZE notes
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle('Notes · acme-app');
    const notes = page.getByRole('region', { name: 'All notes' }).getByRole('listitem');
    await expect(notes).toHaveCount(PAGE_SIZE);
    // a click before hydration would be lost
    await expect(page.getByRole('button', { name: 'Load more' })).toBeDisabled();
  });

  test('unknown pages and notes answer 404 with the not-found page', async ({ page }) => {
    // the note route's own message, not only the router's default page
    for (const [path, message] of [
      [`/notes/${randomUUID()}`, 'No note has this address.'],
      ['/notes/nope', 'No note has this address.'],
      ['/nowhere', 'This page does not exist.'],
    ] as const) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
      await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
      await expect(page.getByText(message), path).toBeVisible();
    }
  });
});

test('Load more pages through the board, down to the oldest note', async ({
  page,
  request,
  createNote,
  seeded,
}) => {
  test.skip(!seeded, NEEDS_SEED); // the oldest note is the seed's first
  // at least three pages, so the loop below must load more than once (other specs only add notes)
  const { notes: firstNotes } = await gql<{ notes: { edges: unknown[] } }>(
    request,
    /* GraphQL */ `
      query E2EBoardNoteCount($first: Int!) {
        notes(first: $first) {
          edges {
            cursor
          }
        }
      }
    `,
    { first: 2 * PAGE_SIZE + 1 },
  );
  for (let count = firstNotes.edges.length; count <= 2 * PAGE_SIZE; count++) await createNote();

  await page.goto('/');
  await showOnBoard(page, page.getByRole('link', { name: SEED.title(1), exact: true }));
  await expect(page.getByRole('button', { name: 'Load more' })).toBeHidden();
});

test.describe('a browser far from UTC', () => {
  // a timestamp formatted in local time would differ from the server's: a hydration mismatch
  test.use({ timezoneId: 'Pacific/Kiritimati' });
  test.skip(({ seeded }) => !seeded, NEEDS_SEED);

  test('a seed note: title, body, UTC time, and its newest comments with the count', async ({
    page,
    request,
  }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));

    const response = await page.goto(`/notes/${await seedNoteId(request, 3)}`);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(`${SEED.title(3)} · acme-app`);
    const note = page.getByRole('article');
    await expect(note.getByRole('heading', { name: SEED.title(3) })).toBeVisible();
    await expect(note.getByText('Body of seed note 3.')).toBeVisible();
    // the seed's fixed time (2026-01-01 09:00 UTC plus n minutes), in UTC in every browser
    await expect(note.getByText('2026-01-01 09:03 UTC')).toBeVisible();

    // the list only: other parts of the page may show names too
    const comments = page
      .getByRole('region', { name: `${SEED.comments(3)} comments` })
      .getByRole('listitem');
    await expect(comments).toHaveCount(SEED.comments(3));
    // newest first; a comment without a name is by "Anonymous"
    await expect(comments.nth(0)).toContainText('Reader 3');
    await expect(comments.nth(1)).toContainText('Anonymous');
    await expect(comments.nth(2)).toContainText('Reader 1');
    await expect(comments.nth(2)).toContainText('Comment 1 on seed note 3.');
    expect(errors).toEqual([]);
  });
});

test('a click anywhere on a card opens its note, not only on the title', async ({
  page,
  createNote,
}) => {
  const note = await createNote({ body: 'Click me, not the title.' });
  await page.goto('/');
  const body = page
    .getByRole('listitem')
    .filter({ hasText: note.title })
    .getByText('Click me, not the title.');
  // a raw click where the body is drawn (locator.click() would refuse: the link covers it there)
  await body.scrollIntoViewIfNeeded();
  const box = await body.boundingBox();
  if (!box) throw new Error('the note body is not on the board');
  await page.mouse.click(box.x + 4, box.y + box.height / 2);
  await expect(page).toHaveURL(new RegExp(`/notes/${note.id}$`));
  await expect(page.getByRole('heading', { name: note.title })).toBeVisible();
});

test('note text renders as plain text, and a long word wraps on a phone', async ({
  page,
  createNote,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const note = await createNote({
    title: uniqueTitle('<img src=x onerror=alert(1)>'),
    body: 'x'.repeat(400),
  });
  for (const path of ['/', `/notes/${note.id}`]) {
    await page.goto(path);
    await expect(page.getByText(note.title, { exact: true })).toBeVisible();
    await expect(page.locator('img')).toHaveCount(0);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal scroll on ${path}`).toBe(0);
  }
});
