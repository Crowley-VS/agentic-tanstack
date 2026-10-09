// Server-only: one request id and one client IP per incoming request, shared by everything that
// logs the request or passes it on: the request log (start.ts), the BFF, and SSR's calls to the
// API (execute()). They are kept on the Request object, which Start hands to its middleware and
// route handlers and returns from getRequest(), so each is worked out once per request.
import { randomUUID } from 'node:crypto';
import { REQUEST_ID_HEADER } from '@acme/validators/internal-api';
import { getRequest, getRequestIP } from '@tanstack/react-start/server';
import { type ServerEnv, serverEnv } from '../env.server';
import { clientIp } from './client-ip.server';

export type RequestContext = {
  /** Ties together this server's log lines and the API's for the request (x-request-id). */
  requestId: string;
  /** The browser's IP (server/client-ip.server.ts), when known. */
  clientIp: string | undefined;
};

/** Which proxy headers to believe: ServerEnv's two settings. */
type ProxyHeaders = Pick<ServerEnv, 'REAL_IP_HEADER' | 'EDGE_REQUEST_ID_HEADER'>;

/** What a request id may look like: short, and safe to print in a log line. */
const REQUEST_ID = /^[\w.:-]{1,128}$/;

/**
 * The request's id: the proxy's own id for it (EDGE_REQUEST_ID_HEADER, Railway's edge request id,
 * so the logs match the platform's HTTP log), else an x-request-id the client or another proxy
 * sent, else a new UUID. Only short, plain values are taken: the id goes into log lines.
 */
export function requestIdOf(headers: Headers, edgeHeader: string): string {
  for (const name of [edgeHeader, REQUEST_ID_HEADER]) {
    const given = name ? headers.get(name) : null;
    if (given !== null && REQUEST_ID.test(given)) return given;
  }
  return randomUUID();
}

const contexts = new WeakMap<Request, RequestContext>();

/** The request's id and client IP, worked out on the first call and the same on every later one. */
export function requestContext(
  request: Request,
  env: ProxyHeaders,
  socketIp: string | undefined,
): RequestContext {
  let context = contexts.get(request);
  if (!context) {
    context = {
      requestId: requestIdOf(request.headers, env.EDGE_REQUEST_ID_HEADER),
      clientIp: clientIp(request.headers, socketIp, env.REAL_IP_HEADER),
    };
    contexts.set(request, context);
  }
  return context;
}

/**
 * The proxy settings to log with: the environment's, or with an invalid environment (which fails
 * the healthcheck and every BFF call) none, so that nothing a client sent is believed.
 */
export function proxyHeaders(): ProxyHeaders {
  try {
    return serverEnv();
  } catch {
    return { REAL_IP_HEADER: '', EDGE_REQUEST_ID_HEADER: '' };
  }
}

/**
 * The context of the request Start is handling (SSR, a server route); undefined outside one, e.g.
 * in a unit test that calls server code directly.
 */
export function currentRequestContext(): RequestContext | undefined {
  try {
    return requestContext(getRequest(), proxyHeaders(), getRequestIP());
  } catch {
    return undefined;
  }
}
