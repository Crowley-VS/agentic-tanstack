// The API is private: only the web server's BFF calls it, with the shared INTERNAL_API_SECRET in
// a header. Enforced on every request whenever a secret is given (app.ts: in production). The
// health check stays open for the platform's probes because Yoga answers it before any user plugin
// runs; nothing else is exempt, since Yoga runs any URL ending in /graphql (`/health?/graphql`
// too) as GraphQL.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Plugin } from 'graphql-yoga';

export const SECRET_HEADER = 'x-internal-secret';

/** Hashed first, so timingSafeEqual compares equal lengths and the secret's length never leaks. */
const digest = (value: string) => createHash('sha256').update(value).digest();

export function useInternalSecret(secret: string | undefined): Plugin {
  if (!secret) return {};
  const expected = digest(secret);
  return {
    onRequest(payload) {
      const given = payload.request.headers.get(SECRET_HEADER);
      if (given !== null && timingSafeEqual(digest(given), expected)) return;
      payload.endResponse(
        new payload.fetchAPI.Response(JSON.stringify({ errors: [{ message: 'Unauthorized' }] }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  };
}
