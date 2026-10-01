// GET /api/health, the platform's healthcheck. It checks this server's own configuration (no I/O,
// and never the API: an API outage must not get the web service restarted). A deploy with an
// invalid environment (e.g. no INTERNAL_API_SECRET in production) fails its healthcheck instead of
// answering 500 to every request.
import { serverEnv } from '../env.server';

const noStore = { 'cache-control': 'no-store' };

export function health(source: Record<string, string | undefined> = process.env): Response {
  try {
    serverEnv(source);
  } catch (err) {
    // the reason goes to the server log only; it names variables, never their values
    console.error('[web] /api/health:', err instanceof Error ? err.message : err);
    return Response.json({ status: 'unavailable' }, { status: 503, headers: noStore });
  }
  return Response.json({ status: 'ok' }, { headers: noStore });
}
