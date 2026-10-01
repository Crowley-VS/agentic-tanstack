// Server-only: which IP a browser request came from, as the BFF tells the API (x-client-ip).
import { isIP, isIPv4 } from 'node:net';

/**
 * The browser's IP: the `header` (REAL_IP_HEADER) the proxy in front sets, when it holds an IP,
 * else the socket's address (Start's getRequestIP()). Never X-Forwarded-For, whose first entries
 * the client writes itself. An IPv4 address in IPv6 form (`::ffff:1.2.3.4`, from a dual-stack
 * socket) is unwrapped.
 */
export function clientIp(
  headers: Headers,
  socketIp: string | undefined,
  header: string,
): string | undefined {
  const named = header ? headers.get(header)?.trim() : undefined;
  const ip = named && isIP(named) ? named : socketIp;
  return ip?.startsWith('::ffff:') && isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
}
