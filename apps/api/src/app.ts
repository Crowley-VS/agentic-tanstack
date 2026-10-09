// The Yoga app: schema, request context and the security defaults. A pure factory (no env reads,
// no connections), so tests call it directly with `yoga.fetch`.
import type { Db } from '@acme/db';
import type { Logger } from '@acme/logger';
import { MAX_TOKENS } from '@acme/validators/internal-api';
import { EnvelopArmorPlugin } from '@escape.tech/graphql-armor';
import { useCSRFPrevention } from '@graphql-yoga/plugin-csrf-prevention';
import { useDisableIntrospection } from '@graphql-yoga/plugin-disable-introspection';
import { createYoga } from 'graphql-yoga';
import type { Env } from './env';
import type { Context } from './graphql/builder';
import { schema } from './graphql/schema';
import { fromWebServer, useInternalSecret } from './plugins/internal-secret';
import { useReadOnly } from './plugins/read-only';
import { useRequestLog, yogaLogger } from './plugins/request-log';

export const GRAPHQL_PATH = '/graphql';
export const HEALTH_PATH = '/health';

/**
 * `log` gets one line per request, and Yoga's own lines (main.ts passes the server's logger); tests
 * leave it out, and Yoga then logs an unexpected error to the console itself.
 */
export function createApp({ db, env, log }: { db: Db; env: Env; log?: Logger }) {
  const production = env.NODE_ENV === 'production';
  return createYoga<Record<string, unknown>, Context>({
    schema,
    graphqlEndpoint: GRAPHQL_PATH,
    healthCheckEndpoint: HEALTH_PATH,
    // READ_ONLY reaches the schema per request (Query.readOnly): the schema reads no environment
    context: () => ({ db, readOnly: env.READ_ONLY }),
    // the browser never calls the API directly: web's BFF does, server to server
    cors: false,
    // development only: an explorer and introspection help agents and people, not attackers
    graphiql: !production,
    landingPage: false,
    // unexpected errors reach the client as "Unexpected error." (details stay in the server log)
    maskedErrors: true,
    ...(log && { logging: yogaLogger(log) }),
    plugins: [
      // first of ours, so it times the whole request and sees the secret check's 401 too (Yoga's
      // health check and GraphiQL page answer before it); it trusts the forwarded client IP and
      // request id whenever the secret matches (in development too)
      ...(log ? [useRequestLog({ trusted: fromWebServer(env.INTERNAL_API_SECRET), log })] : []),
      // production only: in development Nx loads the root .env (which sets the secret) into every
      // task, and GraphiQL, curl and agents must work on 127.0.0.1 without it
      useInternalSecret(production ? env.INTERNAL_API_SECRET : undefined),
      // a request a browser could send cross-site without a preflight (GET, form posts) needs
      // this header; the BFF's JSON POSTs never do
      useCSRFPrevention({ requestHeaders: ['x-graphql-yoga-csrf'] }),
      ...(production ? [useDisableIntrospection()] : []),
      useReadOnly(env.READ_ONLY),
      // cheap limits checked before execution; the Complexity plugin (builder.ts) adds per-field cost
      EnvelopArmorPlugin({
        maxDepth: { n: 10 },
        maxAliases: { n: 15 },
        maxDirectives: { n: 10 },
        maxTokens: { n: MAX_TOKENS },
        costLimit: { maxCost: 5000 },
        blockFieldSuggestion: { enabled: production },
      }),
    ],
  });
}

export type App = ReturnType<typeof createApp>;
