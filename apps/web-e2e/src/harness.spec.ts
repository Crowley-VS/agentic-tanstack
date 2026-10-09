// The harness itself: the production web server's health check answers, and the BFF carries a
// write and a read to the API, which runs in production mode (it refuses a caller without the
// internal secret). The pages: board.spec.ts.
import { expect, gql, test, uniqueTitle } from './fixtures';

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
  apiURL,
}) => {
  // against the production images, CI checks it from inside their network (docs/deployment.md)
  test.skip(!apiURL, 'the private API is out of reach: BASE_URL mode without API_URL');
  expect((await request.get(`${apiURL}/health`)).status()).toBe(200);
  const response = await request.post(`${apiURL}/graphql`, {
    data: { query: '{ apiVersion }' },
  });
  expect(response.status()).toBe(401);
});
