// One log line per request: status, method, path, duration, and who asked. The web server sends
// the browser's IP and a request id (x-client-ip, x-request-id); they are believed only on a
// request that carries the internal secret (`trusted`), else the line shows the socket's address.
// Yoga's health check and (in development) GraphiQL's page answer before any plugin's onRequest,
// so they are not logged.
//
// Yoga's own log lines (an unexpected error, logged before it is masked) carry the same request
// id: `yogaLogger()` reads it from the request's async context, entered in onRequest.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Logger } from '@acme/logger';
import { CLIENT_IP_HEADER, REQUEST_ID_HEADER } from '@acme/validators/internal-api';
import type { Plugin, YogaLogger } from 'graphql-yoga';

type Options = {
  trusted: (request: Request) => boolean;
  log: Logger;
};

type RequestInfo = { started: number; requestId?: string; ip?: string };

/** The request being handled, in its async context: what Yoga's own log lines are tagged with. */
const current = new AsyncLocalStorage<RequestInfo>();

/** The node:http socket's address, when Yoga runs behind node:http (main.ts); not via yoga.fetch. */
function socketAddress(serverContext: unknown): string | undefined {
  const req: unknown = serverContext instanceof Object ? Reflect.get(serverContext, 'req') : null;
  const socket: unknown = req instanceof Object ? Reflect.get(req, 'socket') : null;
  const address: unknown = socket instanceof Object ? Reflect.get(socket, 'remoteAddress') : null;
  return typeof address === 'string' ? address : undefined;
}

export function useRequestLog({ trusted, log }: Options): Plugin {
  const requests = new WeakMap<Request, RequestInfo>();
  return {
    onRequest({ request, serverContext }) {
      const fromWeb = trusted(request);
      // an empty value counts as none
      const header = (name: string) =>
        fromWeb ? request.headers.get(name) || undefined : undefined;
      const info: RequestInfo = {
        started: performance.now(),
        requestId: header(REQUEST_ID_HEADER),
        // the socket's address now: it is gone once the client hangs up
        ip: header(CLIENT_IP_HEADER) ?? socketAddress(serverContext),
      };
      requests.set(request, info);
      // the rest of this request's handling (its own async context) sees it: yogaLogger() below
      current.enterWith(info);
    },
    onResponse({ request, response }) {
      const info = requests.get(request);
      if (!info) return;
      log.request({
        method: request.method,
        path: new URL(request.url).pathname,
        status: response.status,
        ms: Math.round(performance.now() - info.started),
        ip: info.ip,
        requestId: info.requestId,
      });
    },
  };
}

/**
 * Yoga's logger (createYoga's `logging`), writing through ours: an unexpected error that Yoga masks
 * for the client is logged here, with its stack and the request id. Debug lines are dropped.
 */
export function yogaLogger(log: Logger): YogaLogger {
  const write =
    (level: 'info' | 'warn' | 'error') =>
    (...args: unknown[]) => {
      const err = args.find((arg) => arg instanceof Error);
      const text = args.filter((arg) => typeof arg === 'string').join(' ');
      const message = text || (err instanceof Error ? err.message : 'GraphQL server event');
      log[level](message, { requestId: current.getStore()?.requestId, err });
    };
  return { debug: () => {}, info: write('info'), warn: write('warn'), error: write('error') };
}
