// GET /api/health, the platform's healthcheck. It checks this server's own configuration (no I/O,
// and never the API: an API outage must not get the web service restarted). A deploy with an
// invalid environment (e.g. no INTERNAL_API_SECRET in production) fails its healthcheck instead of
// answering 500 to every request.
// It also says which version is deployed (APP_VERSION; `dev` when unset), as the API's
// Query.apiVersion does.
import { serverEnv } from '../env.server';
import { log } from './log.server';

const noStore = { 'cache-control': 'no-store' };

export function health(source: Record<string, string | undefined> = process.env): Response {
  let version: string;
  try {
    version = serverEnv(source).APP_VERSION ?? 'dev';
  } catch (err) {
    // the reason goes to the server log only; it names variables, never their values
    log().error(`/api/health: ${err instanceof Error ? err.message : String(err)}`);
    return Response.json({ status: 'unavailable' }, { status: 503, headers: noStore });
  }
  return Response.json({ status: 'ok', version }, { headers: noStore });
}
