// The server route files only wire methods to handlers (tested next to their modules). Test files
// stay out of src/routes: the route generator would treat them as routes.
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { CLIENT_IP_HEADER, SECRET_HEADER } from '@acme/validators/internal-api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BFF_PATH } from './lib/graphql/execute';
import { getRouter } from './router';
import { Route as GraphqlRoute } from './routes/api/graphql';
import { Route as HealthRoute } from './routes/api/health';

// getRequestIP() reads the request Start is serving (its AsyncLocalStorage), which a direct call
// has none of: stand in for the socket's address
vi.mock('@tanstack/react-start/server', () => ({ getRequestIP: () => '203.0.113.9' }));

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A server route's method handlers, as its file declares them. */
function handlers(route: { options: object }): object {
  const server: unknown = Reflect.get(route.options, 'server');
  const found: unknown = server instanceof Object ? Reflect.get(server, 'handlers') : undefined;
  if (!(found instanceof Object)) throw new Error('not a server route');
  return found;
}

/** Call one handler directly, without a Start server around it. */
async function call(
  route: { options: object },
  method: string,
  init: RequestInit = {},
): Promise<Response> {
  const handler: unknown = Reflect.get(handlers(route), method);
  if (typeof handler !== 'function') throw new Error(`no ${method} handler`);
  const request = new Request('http://web.test/', { method, ...init });
  const res: unknown = await handler({ request });
  if (!(res instanceof Response)) throw new Error(`${method} did not answer a Response`);
  return res;
}

describe('server routes', () => {
  it('GET /api/health answers the health check', async () => {
    const res = await call(HealthRoute, 'GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('/api/health answers 405 to every method but GET (and HEAD), instead of the HTML page', async () => {
    // Start serves HEAD with GET when there is no HEAD handler, and the rest with ANY
    expect(Object.keys(handlers(HealthRoute)).toSorted()).toEqual(['ANY', 'GET']);
    const res = await call(HealthRoute, 'ANY');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });

  it('/api/graphql answers 405 to every method but POST, instead of the HTML page', async () => {
    expect(Object.keys(handlers(GraphqlRoute)).toSorted()).toEqual(['ANY', 'POST']);
    const res = await call(GraphqlRoute, 'ANY');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('POST /api/graphql proxies to the API this process environment names', async () => {
    let received: IncomingHttpHeaders | undefined;
    const api = createServer((req, res) => {
      received = req.headers;
      res.writeHead(200, { 'content-type': 'application/graphql-response+json' });
      res.end('{"data":{"ok":true}}');
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    try {
      const address = api.address();
      if (address === null || typeof address === 'string') throw new Error('stub API has no port');
      vi.stubEnv('API_HOST', '127.0.0.1');
      vi.stubEnv('API_PORT', String(address.port));
      vi.stubEnv('INTERNAL_API_SECRET', 's'.repeat(32));
      const res = await call(GraphqlRoute, 'POST', {
        headers: { 'content-type': 'application/json' },
        body: '{"query":"{ ok }"}',
      });
      expect(await res.json()).toEqual({ data: { ok: true } });
      expect(received?.[SECRET_HEADER]).toBe('s'.repeat(32));
      expect(received?.[CLIENT_IP_HEADER]).toBe('203.0.113.9'); // the socket's address
    } finally {
      api.closeAllConnections();
      await new Promise<void>((resolve) => api.close(() => resolve()));
    }
  });

  it("/api/graphql is the path execute()'s browser branch posts to", () => {
    expect(getRouter().routesByPath[BFF_PATH]).toBe(GraphqlRoute);
  });
});
