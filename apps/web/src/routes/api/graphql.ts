// POST /api/graphql: the BFF proxy to the private API (see graphql-proxy.server.ts).
import { createFileRoute } from '@tanstack/react-router';
import { serverEnv } from '../../env.server';
import { methodNotAllowed, proxyGraphql } from '../../server/graphql-proxy.server';

export const Route = createFileRoute('/api/graphql')({
  server: {
    handlers: {
      // the env is read per request, never at import time; an invalid one fails here (500, logged)
      POST: ({ request }) => proxyGraphql(request, serverEnv()),
      // every other method: without this, GET (and HEAD) would fall through to the page renderer
      // and answer 200 HTML
      ANY: () => methodNotAllowed(),
    },
  },
});
