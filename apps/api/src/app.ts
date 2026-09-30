// The Yoga app: schema, request context and the security defaults. A pure factory (no env reads,
// no connections), so tests call it directly with `yoga.fetch`.
import type { Db } from '@acme/db';
import { EnvelopArmorPlugin } from '@escape.tech/graphql-armor';
import { useCSRFPrevention } from '@graphql-yoga/plugin-csrf-prevention';
import { useDisableIntrospection } from '@graphql-yoga/plugin-disable-introspection';
import { createYoga } from 'graphql-yoga';
import type { Env } from './env';
import type { Context } from './graphql/builder';
import { schema } from './graphql/schema';
import { useInternalSecret } from './plugins/internal-secret';

export const GRAPHQL_PATH = '/graphql';
export const HEALTH_PATH = '/health';

export function createApp({ db, env }: { db: Db; env: Env }) {
  const production = env.NODE_ENV === 'production';
  return createYoga<Record<string, unknown>, Context>({
    schema,
    graphqlEndpoint: GRAPHQL_PATH,
    healthCheckEndpoint: HEALTH_PATH,
    context: () => ({ db }),
    // the browser never calls the API directly: web's BFF does, server to server
    cors: false,
    // development only: an explorer and introspection help agents and people, not attackers
    graphiql: !production,
    landingPage: false,
    // unexpected errors reach the client as "Unexpected error." (details stay in the server log)
    maskedErrors: true,
    plugins: [
      useInternalSecret(env.INTERNAL_API_SECRET, HEALTH_PATH),
      // a request a browser could send cross-site without a preflight (GET, form posts) needs
      // this header; the BFF's JSON POSTs never do
      useCSRFPrevention({ requestHeaders: ['x-graphql-yoga-csrf'] }),
      ...(production ? [useDisableIntrospection()] : []),
      // cheap limits checked before execution; the Complexity plugin (builder.ts) adds per-field cost
      EnvelopArmorPlugin({
        maxDepth: { n: 10 },
        maxAliases: { n: 15 },
        maxDirectives: { n: 10 },
        maxTokens: { n: 2000 },
        costLimit: { maxCost: 5000 },
        blockFieldSuggestion: { enabled: production },
      }),
    ],
  });
}

export type App = ReturnType<typeof createApp>;
