// Server-only: what the request middleware in start.ts does for every request Start handles (pages,
// server routes, server functions; Nitro serves the static assets itself, unlogged):
//
// - one log line: status, method, path, time to the response, client IP and request id (the
//   health check is left out, as in the API);
// - the request id on the answer (x-request-id), so a visitor's report can be found in the logs;
// - after SIGTERM, `connection: close` on every answer. Nitro's server (srvx) then stops accepting
//   connections and waits for the open ones, up to SERVER_SHUTDOWN_TIMEOUT (5 s) before it cuts
//   them; a keep-alive connection (the platform's proxy keeps them) stays open after its last
//   response, so without this each shutdown would take the full 5 s and cut what came meanwhile;
// - on SIGTERM, one line that says so, before srvx's own countdown (sigtermFlag).
import type { EventEmitter } from 'node:events';
import { REQUEST_ID_HEADER } from '@acme/validators/internal-api';
import { getRequestIP } from '@tanstack/react-start/server';
import { log, newlineBeforeEachLine } from './log.server';
import { proxyHeaders, requestContext } from './request-context.server';

/** The platform's healthcheck (routes/api/health.ts): not logged. */
export const HEALTH_PATH = '/api/health';

/**
 * Whether SIGTERM has arrived, as a function. srvx handles the signal (it closes the server, then
 * the process exits) unless CI or TEST is set; then nothing listens and Node's default ends the
 * process at once. So this listens only next to another listener: one of its own would cancel
 * that default, and the process would ignore SIGTERM.
 *
 * It listens ahead of srvx, whose countdown on stderr starts a line it leaves open until the server
 * has closed: the SIGTERM line is written before it, and it and every line after it start with a
 * newline (newlineBeforeEachLine, log.server.ts), so each stays whole in whatever order a platform
 * reads stdout and stderr.
 */
export function sigtermFlag(proc: EventEmitter = process): () => boolean {
  let received = false;
  if (proc.listenerCount('SIGTERM') > 0)
    proc.prependOnceListener('SIGTERM', () => {
      received = true;
      newlineBeforeEachLine();
      log().info('SIGTERM: finishing in-flight requests, then exiting');
    });
  return () => received;
}

/** Created on the first request: srvx registers its handler when the server starts. */
let processDraining: (() => boolean) | undefined;

type Options = {
  /** Whether the server is shutting down (tests pass their own). */
  draining?: () => boolean;
  /** The socket's address (tests pass their own; Start's getRequestIP() needs a live request). */
  socketIp?: () => string | undefined;
};

/** Runs the rest of the request (`next`), then logs it. */
export async function logRequest<T extends { response: Response }>(
  request: Request,
  next: () => T | Promise<T>,
  { draining = (processDraining ??= sigtermFlag()), socketIp = getRequestIP }: Options = {},
): Promise<T> {
  const started = performance.now();
  const { requestId, clientIp } = requestContext(request, proxyHeaders(), socketIp());
  const path = new URL(request.url).pathname;
  let status = 500; // unless the rest of the request answers
  try {
    const result = await next();
    status = result.response.status;
    try {
      const { headers } = result.response;
      if (!headers.has(REQUEST_ID_HEADER)) headers.set(REQUEST_ID_HEADER, requestId);
      if (draining()) headers.set('connection', 'close');
    } catch {
      // a Response.redirect()'s headers are immutable: it is sent as it is
    }
    return result;
  } catch (err) {
    // the connection closed before the answer (the browser left, or a shutdown cut it off)
    if (request.signal.aborted) status = 499;
    throw err;
  } finally {
    if (path !== HEALTH_PATH)
      log().request({
        method: request.method,
        path,
        status,
        ms: Math.round(performance.now() - started),
        ip: clientIp,
        requestId,
      });
  }
}
