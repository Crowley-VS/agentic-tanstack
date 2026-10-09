// The harness itself: the production web server's health check answers with its version, every
// answer carries a request id, and the BFF carries a write and a read to the API, which runs in
// production mode (it refuses a caller without the internal secret). The pages: board.spec.ts.
import { expect, gql, test, uniqueTitle } from './fixtures';

/** A request id the web server takes or makes (apps/web/src/server/request-context.server.ts). */
const REQUEST_ID = /^[\w.:-]{1,128}$/;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

test('the web health check answers ok, with the deployed version', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok', version: expect.any(String) });
});

test("every answer carries its request id: the edge's when it sent one", async ({
  request,
  apiURL,
}) => {
  // Railway's edge names each request in x-railway-request-id; the web server's and the API's log
  // lines for it carry that id. Without API_URL the stack may be a deploy behind such an edge,
  // which may put its own id in that header: then any id will do.
  const behindNoEdge = apiURL !== undefined;
  const page = await request.get('/', { headers: { 'x-railway-request-id': 'e2e-edge-1' } });
  expect(page.status()).toBe(200);
  expect(page.headers()['x-request-id']).toMatch(behindNoEdge ? /^e2e-edge-1$/ : REQUEST_ID);
  const bff = await request.post('/api/graphql', { data: { query: '{ readOnly }' } });
  expect(bff.headers()['x-request-id']).toMatch(behindNoEdge ? UUID : REQUEST_ID);
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
