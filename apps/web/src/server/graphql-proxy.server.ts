// The BFF proxy behind POST /api/graphql: the browser's only way to the API. Same-origin POST +
// JSON only, at most 64 KB, writes rate-limited per client; the server adds the shared secret (so
// it never reaches the browser), the client's IP and a request id.
import { REQUEST_ID_HEADER } from '@acme/validators/internal-api';
import type { ServerEnv } from '../env.server';
import { callInternalApi, transportFailure } from './internal-api.server';
import { log } from './log.server';
import { clientKey, rateLimited, writeLimiter, writesIn } from './rate-limit.server';
import { requestContext } from './request-context.server';
import { errorResponse } from './responses.server';

/** GraphQL documents plus variables for this app stay far below this. */
export const MAX_BODY_BYTES = 64 * 1024;

type ProxyOptions = {
  /** The socket's address (Start's getRequestIP()): the client's IP when no proxy names it. */
  socketIp?: string;
  /** How long to wait for the API (tests shorten it). */
  timeoutMs?: number;
};

export async function proxyGraphql(
  request: Request,
  env: ServerEnv,
  { socketIp, timeoutMs }: ProxyOptions = {},
): Promise<Response> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\s*(;|$)/i.test(type))
    return errorResponse(415, 'Content-Type must be application/json');
  const body = await readBodyText(request, MAX_BODY_BYTES);
  if (body === null)
    return errorResponse(413, `Request body is larger than ${MAX_BODY_BYTES} bytes`);
  // the same id and IP as the request log's line for this request (start.ts). Every answer from
  // here carries the id (the request log adds it to the earlier ones), so a visitor's report can
  // be found in the logs
  const { requestId, clientIp } = requestContext(request, env, socketIp);
  const idHeader = { [REQUEST_ID_HEADER]: requestId };
  // only a body that got this far uses up writes; a refused write never reaches the API
  const writes = env.writeRateLimit ? writesIn(body) : 0;
  if (env.writeRateLimit && writes > 0) {
    const verdict = writeLimiter(env.writeRateLimit).hit(clientKey(clientIp), writes);
    if (!verdict.ok) return rateLimited(verdict.retryAfterSeconds, idHeader);
  }
  let upstream: Response;
  try {
    // no browser headers (cookies, auth) are forwarded: the API sees the body, the secret, the
    // client's IP and the request id
    upstream = await callInternalApi(env, body, {
      signal: request.signal,
      clientIp,
      requestId,
      timeoutMs,
    });
  } catch (err) {
    // The browser went away: nobody reads this answer and the API is fine, so no error log
    // (Start still logs the request's AbortError once, after this returns).
    if (request.signal.aborted) return new Response(null, { status: 499 });
    const { status, message } = transportFailure(err);
    log().error(`/api/graphql: ${message}`, { requestId, err });
    return errorResponse(status, message, { headers: idHeader });
  }
  // of the API's headers only the content type is relayed: no API cookies, CORS or server
  // headers reach the browser
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      ...idHeader,
    },
  });
}

/**
 * The request body as text, or `null` once it exceeds `limit` bytes. Checks the declared
 * Content-Length first, then counts while streaming (a chunked body declares none), so an
 * oversized body is never buffered whole.
 */
export async function readBodyText(request: Request, limit: number): Promise<string | null> {
  if (Number(request.headers.get('content-length') ?? 0) > limit) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
