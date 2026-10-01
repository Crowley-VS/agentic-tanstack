// The harness itself: the production web server renders pages with data from the API (SSR, then
// hydration), its health check answers, and the BFF carries a write and a read to the API, which
// runs in production mode (it refuses a caller without the internal secret).
import { expect, gql, test, uniqueTitle } from './fixtures';

test('the home page renders the API version on the server, and Refresh refetches it', async ({
  page,
}) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  // in the server's HTML: the loader awaited the query during SSR
  expect(await response?.text()).toMatch(/API version/);
  await expect(page.getByRole('heading', { name: 'acme-app' })).toBeVisible();
  await expect(page.getByText(/^API version \S+/)).toBeVisible();
  // a click that lands before hydration does nothing: retry until the toast shows
  await expect(async () => {
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByText('API version refreshed')).toBeVisible({ timeout: 1000 });
  }).toPass();
});

test('the web health check answers ok', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok' });
});

test('a note created through the BFF reads back by id', async ({ request, createNote }) => {
  const title = uniqueTitle('round trip');
  const created = await createNote({ title, body: 'Written by the harness spec.' });
  const { note } = await gql<{ note: Record<string, unknown> | null }>(
    request,
    /* GraphQL */ `
      query E2ENote($id: ID!) {
        note(id: $id) {
          id
          title
          body
          commentCount
        }
      }
    `,
    { id: created.id },
  );
  expect(note).toEqual({
    id: created.id,
    title,
    body: 'Written by the harness spec.',
    commentCount: 0,
  });
});

test('an invalid note comes back as a ValidationError, not an error', async ({ request }) => {
  const { createNote } = await gql<{ createNote: Record<string, unknown> }>(
    request,
    /* GraphQL */ `
      mutation E2EInvalidNote {
        createNote(input: { title: "   ", body: "x" }) {
          __typename
          ... on ValidationError {
            fieldErrors {
              path
              message
            }
          }
        }
      }
    `,
  );
  expect(createNote).toEqual({
    __typename: 'ValidationError',
    fieldErrors: [{ path: ['input', 'title'], message: 'Title is required' }],
  });
});

test('the API refuses a caller without the internal secret (production mode)', async ({
  request,
}, testInfo) => {
  const apiURL: unknown = testInfo.config.metadata.apiURL; // playwright.config.mts
  if (typeof apiURL !== 'string') throw new Error('playwright.config.mts sets metadata.apiURL');
  expect((await request.get(`${apiURL}/health`)).status()).toBe(200);
  const response = await request.post(`${apiURL}/graphql`, {
    data: { query: '{ apiVersion }' },
  });
  expect(response.status()).toBe(401);
});
