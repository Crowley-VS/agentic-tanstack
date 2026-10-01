// The BFF's write rate limit: at most WRITE_RATE_LIMIT writes (root mutation fields) per client
// per window (the board is public and has no accounts). Queries are never limited. In memory, so
// per process: with several web instances each counts on its own (the effective limit is
// multiplied by the instance count) and a restart forgets every count; a deployment that needs
// one shared count moves it to a shared store (e.g. Redis) or the platform's edge.
import { isIPv6 } from 'node:net';
import { RATE_LIMITED } from '@acme/validators/error-codes';
import {
  type DocumentNode,
  type FragmentDefinitionNode,
  getOperationAST,
  Kind,
  OperationTypeNode,
  parse,
  type SelectionSetNode,
} from 'graphql';
import type { RateLimit } from '../env.server';
import { errorResponse } from './responses.server';

/** Clients remembered at once. A flood of new ones evicts the oldest windows (fail open). */
export const MAX_CLIENTS = 10_000;

/**
 * How many writes a JSON request body may make. A body that surely runs a query makes none; a
 * mutation makes one per root field it selects (aliases let one request run the same mutation
 * many times). A body this cannot make sense of (bad JSON, a batch, no query, a syntax error, an
 * operation operationName does not single out) counts as one write, so no body skips the limit by
 * being read differently here than by the API. The app's own requests always parse.
 */
export function writesIn(body: string): number {
  let params: unknown;
  try {
    params = JSON.parse(body);
  } catch {
    return 1;
  }
  if (!(params instanceof Object) || Array.isArray(params)) return 1;
  const query: unknown = Reflect.get(params, 'query');
  const name: unknown = Reflect.get(params, 'operationName') ?? undefined;
  if (typeof query !== 'string' || (name !== undefined && typeof name !== 'string')) return 1;
  try {
    const document = parse(query, { noLocation: true });
    const operation = getOperationAST(document, name);
    if (operation?.operation === OperationTypeNode.QUERY) return 0;
    if (!operation) return 1;
    return Math.max(1, responseKeys(document, operation.selectionSet).size);
  } catch {
    return 1;
  }
}

/**
 * The response keys (alias, else name) of a selection set's fields, through fragment spreads and
 * inline fragments. The API runs each key once (fields that share one are merged), so for a
 * mutation's root selection each key is one write.
 */
function responseKeys(
  document: DocumentNode,
  selectionSet: SelectionSetNode,
  keys = new Set<string>(),
  spread = new Set<string>(),
): Set<string> {
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) keys.add((selection.alias ?? selection.name).value);
    else if (selection.kind === Kind.INLINE_FRAGMENT)
      responseKeys(document, selection.selectionSet, keys, spread);
    else if (!spread.has(selection.name.value)) {
      // each fragment once: a second spread adds the same keys, and a cycle would never end
      spread.add(selection.name.value);
      const fragment = document.definitions.find(
        (definition): definition is FragmentDefinitionNode =>
          definition.kind === Kind.FRAGMENT_DEFINITION &&
          definition.name.value === selection.name.value,
      );
      if (fragment) responseKeys(document, fragment.selectionSet, keys, spread);
    }
  }
  return keys;
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
export type WriteLimiter = { hit(key: string, writes?: number): Verdict; readonly size: number };

/**
 * A fixed window per client, opened by its first write: `limit` writes, then a 429 until the
 * window closes. A request that would take the count past the limit is refused whole (one with
 * more writes than the limit always is). It holds at most `maxClients` windows.
 */
export function createWriteLimiter(
  { limit, windowMs }: RateLimit,
  { maxClients = MAX_CLIENTS, now = () => performance.now() } = {},
): WriteLimiter {
  // Insertion order is opening order (a client's next window is a new entry), and every window
  // lasts windowMs, so the closed ones are always at the front.
  const windows = new Map<string, { count: number; closesAt: number }>();
  return {
    hit(key, writes = 1) {
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
      if (window.count + writes > limit)
        return {
          ok: false,
          retryAfterSeconds: Math.max(1, Math.ceil((window.closesAt - time) / 1000)),
        };
      window.count += writes;
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
