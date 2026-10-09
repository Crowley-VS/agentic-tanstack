// The private contract between the web server and the API: both sides import it, so a rename or a
// stricter rule changes them together. Server code only (apps/web's *.server.ts, apps/api): web's
// client-bundle check fails a build whose browser code pulls it in.
import * as z from 'zod';

/** Carries INTERNAL_API_SECRET on every web → API request; the API requires it in production. */
export const SECRET_HEADER = 'x-internal-secret';
/** The browser's IP as the web server saw it. The API trusts it only with a matching secret. */
export const CLIENT_IP_HEADER = 'x-client-ip';
/** One id per browser request, in the web and API logs. Trusted like CLIENT_IP_HEADER. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * The most lexical tokens a GraphQL document may have: the API refuses a longer one before
 * parsing it (graphql-armor maxTokens), and the web server's rate limit stops parsing there too.
 */
export const MAX_TOKENS = 2000;

/** INTERNAL_API_SECRET: may be unset in development; at least 32 characters when set. */
export const InternalApiSecret = z
  .string()
  .min(32, 'INTERNAL_API_SECRET must be at least 32 characters')
  .optional();

/**
 * The issue each app's env schema raises when production runs without the secret (each app decides
 * what counts as production). `error`, not `message`: zod rewrites a `message` param in place.
 */
export const SECRET_REQUIRED_IN_PRODUCTION = {
  path: ['INTERNAL_API_SECRET'],
  error: 'INTERNAL_API_SECRET is required in production',
};
