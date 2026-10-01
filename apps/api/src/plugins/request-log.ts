// One log line per request: status, method, path, duration, and who asked. The web server sends
// the browser's IP and a request id (x-client-ip, x-request-id); they are believed only on a
// request that carries the internal secret (`trusted`), else the line shows the socket's address.
// Yoga's health check answers before any plugin's onRequest, so probes are not logged.
import { CLIENT_IP_HEADER, REQUEST_ID_HEADER } from '@acme/validators/internal-api';
import type { Plugin } from 'graphql-yoga';

type Options = {
  trusted: (request: Request) => boolean;
  log: (line: string) => void;
};

/** The node:http socket's address, when Yoga runs behind node:http (main.ts); not via yoga.fetch. */
function socketAddress(serverContext: unknown): string | undefined {
  const req: unknown = serverContext instanceof Object ? Reflect.get(serverContext, 'req') : null;
  const socket: unknown = req instanceof Object ? Reflect.get(req, 'socket') : null;
  const address: unknown = socket instanceof Object ? Reflect.get(socket, 'remoteAddress') : null;
  return typeof address === 'string' ? address : undefined;
}

export function useRequestLog({ trusted, log }: Options): Plugin {
  const started = new WeakMap<Request, number>();
  return {
    onRequest({ request }) {
      started.set(request, performance.now());
    },
    onResponse({ request, response, serverContext }) {
      const start = started.get(request);
      if (start === undefined) return;
      const fromWeb = trusted(request);
      const header = (name: string) => (fromWeb ? request.headers.get(name) : null);
      const ip = header(CLIENT_IP_HEADER) ?? socketAddress(serverContext) ?? '-';
      const id = header(REQUEST_ID_HEADER) ?? '-';
      const ms = Math.round(performance.now() - start);
      log(
        `[api] ${response.status} ${request.method} ${new URL(request.url).pathname} ${ms}ms ip=${ip} id=${id}`,
      );
    },
  };
}
