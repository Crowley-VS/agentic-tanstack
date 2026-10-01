// GET /api/health: 200 when this server's environment is valid, else 503 (see health.server.ts).
import { createFileRoute } from '@tanstack/react-router';
import { health } from '../../server/health.server';

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: () => health(),
    },
  },
});
