// Entry point: validate the environment, open the pool, serve Yoga over node:http. On SIGTERM
// (a deploy or scale-down) it stops accepting requests, lets in-flight ones finish, then closes
// the pool. Node is PID 1 in the container, so these handlers are what shuts it down.
import { createServer } from 'node:http';
import { createDb } from '@acme/db';
import { createApp, GRAPHQL_PATH } from './app';
import { listenPort, loadEnv } from './env';

const env = loadEnv();
const { db, close } = createDb({ url: env.DATABASE_URL, max: env.DB_POOL_MAX });
const yoga = createApp({ db, env });
const server = createServer((req, res) => void yoga(req, res));
const port = listenPort(env);

// Production: `::` (IPv6 and IPv4), since Railway's private network is IPv6-only. Development:
// this machine only, as it serves GraphiQL and introspection and ignores the secret (app.ts
// enforces it with NODE_ENV=production only).
const host = env.NODE_ENV === 'production' ? '::' : '127.0.0.1';
server.listen(port, host, () =>
  console.log(`[api] listening on http://localhost:${port}${GRAPHQL_PATH} (${env.NODE_ENV})`),
);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[api] ${signal}: shutting down`);
  const force = setTimeout(() => process.exit(1), 8000).unref();
  server.closeIdleConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await close();
  clearTimeout(force);
  process.exit(0);
}
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => void shutdown(signal));
