// The API is private: only the web server's BFF calls it, with the shared INTERNAL_API_SECRET in
// a header. Enforced on every request whenever a secret is given (app.ts: in production). The
// health check stays open for the platform's probes because Yoga answers it before any user plugin
// runs; nothing else is exempt, since Yoga runs any URL ending in /graphql (`/health?/graphql`
// too) as GraphQL.
import { createHash, timingSafeEqual } from 'node:crypto';
import { SECRET_HEADER } from '@acme/validators/internal-api';
import type { Plugin } from 'graphql-yoga';

/** Hashed first, so timingSafeEqual compares equal lengths and the secret's length never leaks. */
const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Whether a request carries `secret`, i.e. comes from the web server. Always false without a
 * secret: then nothing the request claims about itself (x-client-ip, x-request-id) is trusted.
 */
export function fromWebServer(secret: string | undefined): (request: Request) => boolean {
  if (!secret) return () => false;
  const expected = digest(secret);
  return (request) => {
    const given = request.headers.get(SECRET_HEADER);
    return given !== null && timingSafeEqual(digest(given), expected);
  };
}

export function useInternalSecret(secret: string | undefined): Plugin {
  if (!secret) return {};
  const trusted = fromWebServer(secret);
  return {
    onRequest(payload) {
      if (trusted(payload.request)) return;
      payload.endResponse(
        new payload.fetchAPI.Response(JSON.stringify({ errors: [{ message: 'Unauthorized' }] }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  };
}
