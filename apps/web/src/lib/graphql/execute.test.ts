// Node, without the Start compiler: createIsomorphicFn runs its .server() branch, so these tests
// cover SSR's direct call to the API (a stub here). The browser branch goes through the BFF
// (postToBff, tested on its own below).
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { environmentManager } from '@tanstack/react-query';
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { ApiVersionDocument, TypedDocumentString } from '../../gql/graphql';
import { BFF_PATH, execute, GraphQLRequestError, postToBff, shouldRetry } from './execute';

const SECRET = 's'.repeat(32);
/** An operation whose variables are all optional (how codegen types `$first: Int`). */
const NotesDocument = new TypedDocumentString<
  { notes: { edges: { cursor: string }[] } },
  { first?: number | null }
>('query Notes($first: Int) { notes(first: $first) { edges { cursor } } }');
/** An operation with a required variable, typed by hand (tests stay out of codegen). */
const NoteDocument = new TypedDocumentString<{ note: { id: string } | null }, { id: string }>(
  'query Note($id: ID!) { note(id: $id) { id } }',
);

let api: Server;
let port: number;
/** What the stub API answers next; `null`: it never answers. */
let reply: { status: number; body: string; type?: string } | null;
let received: { url?: string; headers: IncomingHttpHeaders; body: string } | undefined;

beforeAll(async () => {
  api = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      received = { url: req.url, headers: req.headers, body };
      if (!reply) return;
      res.writeHead(reply.status, {
        'content-type': reply.type ?? 'application/graphql-response+json',
      });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  if (address === null || typeof address === 'string') throw new Error('stub API has no port');
  port = address.port;
});
afterAll(() => {
  api.closeAllConnections();
  return new Promise<void>((resolve) => api.close(() => resolve()));
});
beforeEach(() => {
  received = undefined;
  reply = { status: 200, body: JSON.stringify({ data: { apiVersion: 'dev' } }) };
  // set after execute.ts was imported: it must read the environment on each call
  vi.stubEnv('API_HOST', '127.0.0.1');
  vi.stubEnv('API_PORT', String(port));
  vi.stubEnv('INTERNAL_API_SECRET', SECRET);
  return () => vi.unstubAllEnvs();
});

/**
 * Never called: web:typecheck fails once execute() accepts a line marked @ts-expect-error, or
 * types a result differently.
 */
async function typedCalls() {
  expectTypeOf(await execute(ApiVersionDocument)).toEqualTypeOf<{ apiVersion: string }>();
  // optional variables may be left out
  await execute(NotesDocument);
  await execute(NotesDocument, { first: 5 });
  // @ts-expect-error: this operation requires its variables
  await execute(NoteDocument);
  // @ts-expect-error: `id` is a string
  await execute(NoteDocument, { id: 1 });
}

function sentBody(): unknown {
  if (!received) throw new Error('the API received nothing');
  return JSON.parse(received.body);
}

describe('execute on the server', () => {
  it('posts the document and its variables to the API, with the secret', async () => {
    reply = { status: 200, body: JSON.stringify({ data: { note: { id: 'n1' } } }) };
    await expect(execute(NoteDocument, { id: 'n1' })).resolves.toEqual({ note: { id: 'n1' } });
    expect(received?.url).toBe('/graphql');
    expect(received?.headers['x-internal-secret']).toBe(SECRET);
    expect(sentBody()).toEqual({ query: NoteDocument.toString(), variables: { id: 'n1' } });
  });

  it('reads the API address from the environment on each call', async () => {
    vi.stubEnv('API_PORT', '1'); // nothing listens there
    await expect(execute(ApiVersionDocument)).rejects.toThrow();
    expect(received).toBeUndefined();
    vi.stubEnv('API_PORT', String(port));
    await expect(execute(ApiVersionDocument)).resolves.toEqual({ apiVersion: 'dev' });
  });

  it('sends no variables for an operation that has none', async () => {
    await expect(execute(ApiVersionDocument)).resolves.toEqual({ apiVersion: 'dev' });
    expect(sentBody()).toEqual({ query: ApiVersionDocument.toString() });
  });

  it.each([
    ['a document the API rejects (400)', 400, 'Cannot query field "titel" on type "Query".'],
    ['a masked server error (200)', 200, 'Unexpected error.'],
  ])('rejects with the GraphQL errors of %s', async (_, status, message) => {
    reply = { status, body: JSON.stringify({ data: null, errors: [{ message }] }) };
    const error: unknown = await execute(ApiVersionDocument).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GraphQLRequestError);
    expect(error).toMatchObject({ status, message, errors: [{ message }] });
  });

  it('rejects with the HTTP status of a failed answer that is not GraphQL', async () => {
    reply = { status: 502, body: 'Bad gateway', type: 'text/plain' };
    await expect(execute(ApiVersionDocument)).rejects.toMatchObject({
      name: 'GraphQLRequestError',
      status: 502,
      errors: [],
      message: 'GraphQL request failed (HTTP 502)',
    });
  });

  it("aborts the API call with the caller's signal", async () => {
    reply = null;
    const controller = new AbortController();
    const pending = execute(ApiVersionDocument, undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(received).toBeDefined());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses an operation codegen has not generated yet, without calling the API', async () => {
    // what graphql() returns for a source src/gql does not know (codegen failed or has not run);
    // its type is not a document, so execute() is called untyped
    const ungenerated = {};
    await expect(Reflect.apply(execute, undefined, [ungenerated])).rejects.toThrow(
      'run `pnpm nx run web:codegen`',
    );
    expect(received).toBeUndefined();
  });

  it('types variables and results from the document (web:typecheck checks typedCalls)', () => {
    expect(typedCalls).toBeTypeOf('function');
  });
});

describe('the browser transport', () => {
  it('posts the body to the same-origin BFF, with no secret, forwarding the signal', async () => {
    const fetchSpy = vi.fn(async () => Response.json({ data: { apiVersion: 'dev' } }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const { signal } = new AbortController();
      await postToBff('{"query":"{ apiVersion }"}', signal);
      expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(BFF_PATH, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/graphql-response+json, application/json',
        },
        body: '{"query":"{ apiVersion }"}',
        signal,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('shouldRetry', () => {
  const network = new TypeError('fetch failed');
  const apiDown = new GraphQLRequestError(502, [{ message: 'API unavailable' }]);

  it('never retries on the server', () => {
    expect(environmentManager.isServer()).toBe(true);
    expect(shouldRetry(0, network)).toBe(false);
    expect(shouldRetry(0, apiDown)).toBe(false);
  });

  it('in the browser, retries failures that may pass (at most 3 times) but not GraphQL errors', () => {
    environmentManager.setIsServer(() => false);
    try {
      expect(shouldRetry(0, network)).toBe(true);
      expect(shouldRetry(2, apiDown)).toBe(true);
      expect(shouldRetry(3, apiDown)).toBe(false);
      expect(shouldRetry(0, new GraphQLRequestError(400, [{ message: 'invalid' }]))).toBe(false);
      expect(shouldRetry(0, new GraphQLRequestError(200, [{ message: 'Unexpected error.' }]))).toBe(
        false,
      );
    } finally {
      environmentManager.setIsServer(() => true);
    }
  });
});
