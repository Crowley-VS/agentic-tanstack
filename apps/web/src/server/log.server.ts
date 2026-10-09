// Server-only: the web server's logger (@acme/logger): one JSON line per event in production,
// readable text in development. Created on first use, so the environment is read then, never at
// import.
import { createLogger, type Logger, logFormat } from '@acme/logger';
import { currentRequestContext } from './request-context.server';

let logger: Logger | undefined;

export function log(): Logger {
  logger ??= createLogger({
    app: 'web',
    format: logFormat({
      LOG_FORMAT: process.env.LOG_FORMAT,
      // a production build logs JSON even without NODE_ENV (env.server.ts treats it as production)
      NODE_ENV: import.meta.env.PROD ? 'production' : process.env.NODE_ENV,
    }),
    version: process.env.APP_VERSION ?? 'dev',
  });
  return logger;
}

/** An error line, with the error's stack and the id of the request being handled, if any. */
export function logError(message: string, err: unknown): void {
  log().error(message, { requestId: currentRequestContext()?.requestId, err });
}
