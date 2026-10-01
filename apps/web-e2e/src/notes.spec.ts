// The write side in a real browser, against the production build: the "New note" form on the board
// (with its optional source URL, linked from the note's page) and the "Add a comment" form on a
// note's page. Each test works on a note it created (unique title), never on a seed note, so
// workers, parallel e2e-ci tasks and retries never collide.
import type { Page } from '@playwright/test';
import { expect, test, uniqueTitle } from './fixtures';

const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title', exact: true });
const bodyField = (page: Page) => page.getByRole('textbox', { name: 'Body', exact: true });
const sourceField = (page: Page) =>
  page.getByRole('textbox', { name: 'Source URL (optional)', exact: true });
const sourceLink = (page: Page) => page.getByRole('link', { name: 'Source', exact: true });

/**
 * The note's card on the board. Other specs add notes meanwhile (newest first), so it may have
 * moved past the first page: load more until it shows.
 */
async function boardCard(page: Page, title: string) {
  const notes = page.getByRole('region', { name: 'All notes' });
  const card = notes
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: title, exact: true }) });
  await expect(notes).toBeVisible();
  await expect(async () => {
    if (await card.isVisible()) return;
    await page.getByRole('button', { name: 'Load more' }).click({ timeout: 5000 });
    expect(await card.isVisible()).toBe(true);
  }).toPass();
  return card;
}

test.describe('server-rendered (JavaScript off)', () => {
  test.use({ javaScriptEnabled: false });

  test('the submit buttons are disabled until hydration', async ({ page, createNote }) => {
    // a submit before hydration would be a native GET, with the note in the URL
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Create note' })).toBeDisabled();
    await page.goto(`/notes/${(await createNote()).id}`);
    await expect(page.getByRole('button', { name: 'Add comment' })).toBeDisabled();
  });
});

test('a new note shows in the list, on its own page and after a reload', async ({ page }) => {
  const title = uniqueTitle('new note');
  await page.goto('/');
  await titleField(page).fill(title);
  await bodyField(page).fill('Typed into the form.');
  await page.getByRole('button', { name: 'Create note' }).click();

  // the board refetched before the form came back: the note is on top, the form is reset
  await expect(page.getByText('Note created')).toBeVisible();
  const link = page.getByRole('link', { name: title, exact: true });
  await expect(link).toBeVisible();
  await expect(titleField(page)).toHaveValue('');
  await expect(bodyField(page)).toHaveValue('');

  await link.click();
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByText('Typed into the form.')).toBeVisible();
  await expect(sourceLink(page)).toHaveCount(0); // none given
  // server-rendered too: a reload (no client cache) shows the same note
  await page.reload();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
});

test('a source URL is a "Source" link on the note page, in a new tab, never on the board', async ({
  page,
  baseURL,
}) => {
  const title = uniqueTitle('sourced note');
  // this server's own health URL: the new tab opens without leaving the machine
  const sourceUrl = `${baseURL}/api/health?from=${encodeURIComponent(title)}`;
  await page.goto('/');
  await titleField(page).fill(title);
  await bodyField(page).fill('Has a source.');
  await sourceField(page).fill(` ${sourceUrl} `);
  await page.getByRole('button', { name: 'Create note' }).click();
  await expect(page.getByText('Note created')).toBeVisible();
  await expect(sourceField(page)).toHaveValue('');

  const card = await boardCard(page, title);
  await expect(card.getByRole('link')).toHaveCount(1); // the title only
  await expect(card).not.toContainText(sourceUrl);

  await card.getByRole('link', { name: title, exact: true }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(sourceLink(page)).toHaveAttribute('href', sourceUrl); // trimmed
  // the new tab can neither reach this page (noopener) nor learn its URL (noreferrer)
  const opened = page.waitForEvent('popup');
  await sourceLink(page).click();
  const tab = await opened;
  await expect(tab).toHaveURL(sourceUrl);
  expect(await tab.evaluate(() => [window.opener, document.referrer])).toEqual([null, '']);
  await tab.close();

  // server-rendered too: a reload (no client cache) shows the same link
  await page.reload();
  await expect(sourceLink(page)).toHaveAttribute('href', sourceUrl);
  await expect(sourceLink(page)).toHaveAttribute('target', '_blank');
});

test('a blank title is refused with a field error, and the input is kept', async ({ page }) => {
  await page.goto('/');
  await titleField(page).fill('   ');
  await bodyField(page).fill('No title.');
  await page.getByRole('button', { name: 'Create note' }).click();

  await expect(page.getByText('Title is required')).toBeVisible();
  await expect(titleField(page)).toHaveAttribute('aria-invalid', 'true');
  await expect(bodyField(page)).toHaveValue('No title.');
});

test('comments show newest first, "Anonymous" without a name, and the board count follows', async ({
  page,
  createNote,
}) => {
  const note = await createNote();
  // the board first, so its list is in the client cache: going back must not show a stale count
  await page.goto('/');
  await (await boardCard(page, note.title)).getByRole('link').click();
  await expect(page.getByRole('heading', { name: note.title })).toBeVisible();

  const name = page.getByRole('textbox', { name: 'Your name (optional)', exact: true });
  const comment = page.getByRole('textbox', { name: 'Comment', exact: true });
  const addComment = page.getByRole('button', { name: 'Add comment' });
  await name.fill('Ada');
  await comment.fill('First, signed.');
  await addComment.click();
  await expect(page.getByText('Comment added')).toBeVisible();
  await expect(name).toHaveValue('');
  await expect(comment).toHaveValue('');
  await comment.fill('Second, unsigned.');
  await addComment.click();

  const comments = page.getByRole('region', { name: '2 comments' }).getByRole('listitem');
  await expect(comments).toHaveCount(2);
  await expect(comments.nth(0)).toContainText('Anonymous');
  await expect(comments.nth(0)).toContainText('Second, unsigned.');
  await expect(comments.nth(1)).toContainText('Ada');
  await expect(comments.nth(1)).toContainText('First, signed.');

  await page.getByRole('link', { name: '← All notes' }).click();
  await expect(await boardCard(page, note.title)).toContainText('2 comments');
});
