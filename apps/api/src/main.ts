// Entry point: validate the environment, open the pool, serve Yoga over node:http. On SIGTERM
// (a deploy or scale-down) it stops accepting connections, lets in-flight requests finish, then
// closes the pool. Node is PID 1 in the container, so these handlers are what shuts it down.
import { createServer, type ServerResponse } from 'node:http';
import { createDb } from '@acme/db';
import { createLogger, logFormat } from '@acme/logger';
import { createApp, GRAPHQL_PATH } from './app';
import { listenHost, listenPort, loadEnv, urlHost } from './env';

const env = loadEnv();
const log = createLogger({
  app: 'api',
  format: logFormat(env),
  version: env.APP_VERSION ?? 'dev',
});
const { db, close } = createDb({ url: env.DATABASE_URL, max: env.DB_POOL_MAX });
const yoga = createApp({ db, env, log });

let stopping = false;
/** Responses not yet sent: on SIGTERM they are told to close their connection. */
const pending = new Set<ServerResponse>();
const server = createServer((req, res) => {
  // a keep-alive client (the web server) would hold its idle connection open, and server.close()
  // would wait for it until the force exit below: after SIGTERM, every answer closes its connection
  if (stopping) res.setHeader('connection', 'close');
  // Yoga's adapter builds the request's URL from Host: one that is no URL authority makes it throw
  // before any plugin runs (a 500 with the stack trace, and no log line)
  if (!URL.canParse(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`)) {
    res.writeHead(400).end();
    log.request({
      method: req.method ?? '-',
      path: req.url?.split('?')[0] ?? '/',
      status: 400,
      ms: 0,
      ip: req.socket.remoteAddress,
    });
    return;
  }
  pending.add(res);
  res.once('close', () => pending.delete(res));
  void yoga(req, res);
});
const port = listenPort(env);
const host = listenHost(env);
server.listen(port, host, () =>
  log.info(`listening on http://${urlHost(host)}:${port}${GRAPHQL_PATH} (${env.NODE_ENV})`),
);

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info(`${signal}: finishing in-flight requests, then exiting`, { inFlight: pending.size });
  // under the platform's grace period (RAILWAY_DEPLOYMENT_DRAINING_SECONDS, docker stop's 10 s)
  const force = setTimeout(() => {
    log.error(`${signal}: requests still running after 8 s, exiting anyway`, {
      inFlight: pending.size,
    });
    process.exit(1);
  }, 8000).unref();
  for (const res of pending) if (!res.headersSent) res.setHeader('connection', 'close');
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  await closed;
  await close();
  clearTimeout(force);
  process.exit(0);
}
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => void shutdown(signal));
