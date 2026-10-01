// The BFF's write rate limit: at most WRITE_RATE_LIMIT mutations per client per window (the board
// is public and has no accounts). Queries are never limited. In memory, so per process: with
// several web instances each counts on its own (the effective limit is multiplied by the
// instance count) and a restart forgets every count; a deployment that needs one shared count
// moves it to a shared store (e.g. Redis) or the platform's edge.
import { isIPv6 } from 'node:net';
import { RATE_LIMITED } from '@acme/validators/error-codes';
import { getOperationAST, OperationTypeNode, parse } from 'graphql';
import type { RateLimit } from '../env.server';
import { errorResponse } from './responses.server';

/** Clients remembered at once. A flood of new ones evicts the oldest windows (fail open). */
export const MAX_CLIENTS = 10_000;

/**
 * Whether a JSON request body may change data. Only a body that surely runs a query is a read:
 * one this cannot make sense of (bad JSON, a batch, no query, a syntax error, an operation
 * operationName does not single out) counts as a write, so no body skips the limit by being
 * read differently here than by the API. The app's own requests always parse.
 */
export function isWrite(body: string): boolean {
  let params: unknown;
  try {
    params = JSON.parse(body);
  } catch {
    return true;
  }
  if (!(params instanceof Object) || Array.isArray(params)) return true;
  const query: unknown = Reflect.get(params, 'query');
  const name: unknown = Reflect.get(params, 'operationName') ?? undefined;
  if (typeof query !== 'string' || (name !== undefined && typeof name !== 'string')) return true;
  try {
    const operation = getOperationAST(parse(query, { noLocation: true }), name);
    return operation?.operation !== OperationTypeNode.QUERY;
  } catch {
    return true;
  }
}

/**
 * The bucket a client's writes count in (its IP from clientIp()): an IPv4 address itself, or the
 * /64 network of an IPv6 one (a single host usually gets a whole /64, so per-address buckets
 * would be free to multiply).
 */
export function clientKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  if (!isIPv6(ip)) return ip;
  const [head = '', tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const zeros = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');
  const groups = [...left, ...zeros, ...right].slice(0, 4);
  return `${groups.map((group) => Number.parseInt(group, 16).toString(16)).join(':')}::/64`;
}

export type Verdict = { ok: true } | { ok: false; retryAfterSeconds: number };
export type WriteLimiter = { hit(key: string): Verdict; readonly size: number };

/**
 * A fixed window per client, opened by its first write: `limit` writes, then a 429 until the
 * window closes. It holds at most `maxClients` windows.
 */
export function createWriteLimiter(
  { limit, windowMs }: RateLimit,
  { maxClients = MAX_CLIENTS, now = () => performance.now() } = {},
): WriteLimiter {
  // Insertion order is opening order (a client's next window is a new entry), and every window
  // lasts windowMs, so the closed ones are always at the front.
  const windows = new Map<string, { count: number; closesAt: number }>();
  return {
    hit(key) {
      const time = now();
      for (const [client, window] of windows) {
        if (window.closesAt > time) break;
        windows.delete(client);
      }
      let window = windows.get(key);
      if (!window) {
        if (windows.size >= maxClients) windows.delete(windows.keys().next().value ?? '');
        window = { count: 0, closesAt: time + windowMs };
        windows.set(key, window);
      }
      if (window.count >= limit)
        return {
          ok: false,
          retryAfterSeconds: Math.max(1, Math.ceil((window.closesAt - time) / 1000)),
        };
      window.count += 1;
      return { ok: true };
    },
    get size() {
      return windows.size;
    },
  };
}

let shared: { rule: string; limiter: WriteLimiter } | undefined;

/** The process's limiter for `limit` (the env is parsed per request; the counts must persist). */
export function writeLimiter(limit: RateLimit): WriteLimiter {
  const rule = `${limit.limit}/${limit.windowMs}`;
  if (shared?.rule !== rule) shared = { rule, limiter: createWriteLimiter(limit) };
  return shared.limiter;
}

/**
 * 429 in GraphQL's shape: execute() rejects with it (GraphQLRequestError: `code` RATE_LIMITED,
 * `retryAfter`), and the UI shows the same wording.
 */
export const rateLimited = (retryAfterSeconds: number) =>
  errorResponse(429, `Too many writes: try again in ${retryAfterSeconds} s.`, {
    headers: { 'retry-after': String(retryAfterSeconds) },
    extensions: { code: RATE_LIMITED, retryAfter: retryAfterSeconds },
  });
