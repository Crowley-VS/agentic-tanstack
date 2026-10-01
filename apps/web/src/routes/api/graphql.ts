// POST /api/graphql: the BFF proxy to the private API (see graphql-proxy.server.ts).
import { createFileRoute } from '@tanstack/react-router';
import { getRequestIP } from '@tanstack/react-start/server';
import { serverEnv } from '../../env.server';
import { proxyGraphql } from '../../server/graphql-proxy.server';
import { methodNotAllowed } from '../../server/responses.server';

export const Route = createFileRoute('/api/graphql')({
  server: {
    handlers: {
      // the env is read per request, never at import time; an invalid one fails here (500, logged).
      // getRequestIP() is the socket's address (the Start compiler drops this import from the
      // client bundle).
      POST: ({ request }) => proxyGraphql(request, serverEnv(), { socketIp: getRequestIP() }),
      // every other method: without this, GET (and HEAD) would fall through to the page renderer
      // and answer 200 HTML
      ANY: () => methodNotAllowed('POST'),
    },
  },
});
