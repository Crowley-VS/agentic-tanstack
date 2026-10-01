// The BFF proxy behind POST /api/graphql: the browser's only way to the API. Same-origin POST +
// JSON only, at most 64 KB; the server adds the shared secret, so it never reaches the browser.
import type { ServerEnv } from '../env.server';
import { callInternalApi } from './internal-api.server';

/** GraphQL documents plus variables for this app stay far below this. */
export const MAX_BODY_BYTES = 64 * 1024;

const error = (status: number, message: string, headers?: Record<string, string>) =>
  Response.json({ errors: [{ message }] }, { status, headers });

export const methodNotAllowed = () => error(405, 'Method not allowed: use POST', { allow: 'POST' });

export async function proxyGraphql(request: Request, env: ServerEnv): Promise<Response> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\s*(;|$)/i.test(type))
    return error(415, 'Content-Type must be application/json');
  const body = await readBodyText(request, MAX_BODY_BYTES);
  if (body === null) return error(413, `Request body is larger than ${MAX_BODY_BYTES} bytes`);
  let upstream: Response;
  try {
    // no browser headers (cookies, auth) are forwarded; the API sees only the body and the secret
    upstream = await callInternalApi(env, body, { signal: request.signal });
  } catch (err) {
    console.error('[web] /api/graphql: API unreachable', err);
    return error(502, 'API unavailable');
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
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
