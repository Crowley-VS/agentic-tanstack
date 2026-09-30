// The server route files only wire methods to handlers (tested next to their modules). Test files
// stay out of src/routes: the route generator would treat them as routes.
import { describe, expect, it } from 'vitest';
import { Route as GraphqlRoute } from './routes/api/graphql';
import { Route as HealthRoute } from './routes/api/health';

/** A server route's method handlers, as its file declares them. */
function handlers(route: { options: object }): object {
  const server: unknown = Reflect.get(route.options, 'server');
  const found: unknown = server instanceof Object ? Reflect.get(server, 'handlers') : undefined;
  if (!(found instanceof Object)) throw new Error('not a server route');
  return found;
}

/** Call one handler directly, without a Start server around it. */
async function call(route: { options: object }, method: string): Promise<Response> {
  const handler: unknown = Reflect.get(handlers(route), method);
  if (typeof handler !== 'function') throw new Error(`no ${method} handler`);
  const res: unknown = await handler({ request: new Request('http://web.test/', { method }) });
  if (!(res instanceof Response)) throw new Error(`${method} did not answer a Response`);
  return res;
}

describe('server routes', () => {
  it('GET /api/health answers the health check', async () => {
    const res = await call(HealthRoute, 'GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('/api/graphql answers 405 to every method but POST, instead of the HTML page', async () => {
    expect(Object.keys(handlers(GraphqlRoute)).toSorted()).toEqual(['ANY', 'POST']);
    const res = await call(GraphqlRoute, 'ANY');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});
