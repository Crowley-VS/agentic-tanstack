// The API is private: only the web server's BFF calls it, with the shared INTERNAL_API_SECRET in
// a header. Enforced whenever the secret is set (always in production, see env.ts); the health
// check stays open for the platform's probes.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Plugin } from 'graphql-yoga';

export const SECRET_HEADER = 'x-internal-secret';

/** Hashed first, so timingSafeEqual compares equal lengths and the secret's length never leaks. */
const digest = (value: string) => createHash('sha256').update(value).digest();

export function useInternalSecret(secret: string | undefined, healthPath: string): Plugin {
  if (!secret) return {};
  const expected = digest(secret);
  return {
    onRequest(payload) {
      if (payload.url.pathname === healthPath) return;
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
