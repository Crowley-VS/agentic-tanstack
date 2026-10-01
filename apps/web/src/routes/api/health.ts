// GET /api/health: 200 when this server's environment is valid, else 503 (see health.server.ts).
import { createFileRoute } from '@tanstack/react-router';
import { health } from '../../server/health.server';
import { methodNotAllowed } from '../../server/responses.server';

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      // HEAD too: Start serves it with GET when there is no HEAD handler
      GET: () => health(),
      // every other method: without this, POST and PUT would get the page renderer's 200 HTML
      ANY: () => methodNotAllowed('GET, HEAD'),
    },
  },
});
