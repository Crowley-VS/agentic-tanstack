// Server-only: the web server's logger (@acme/logger): one JSON line per event in production,
// readable text in development. Created on first use, so the environment is read then, never at
// import.
import { consoleWriter, createLogger, type Logger, logFormat } from '@acme/logger';
import { currentRequestContext } from './request-context.server';

let logger: Logger | undefined;
/** What each line starts with: nothing, until newlineBeforeEachLine(). */
let lineStart = '';

export function log(): Logger {
  if (logger) return logger;
  const format = logFormat({
    LOG_FORMAT: process.env.LOG_FORMAT,
    // a production build logs JSON even without NODE_ENV (env.server.ts treats it as production)
    NODE_ENV: import.meta.env.PROD ? 'production' : process.env.NODE_ENV,
  });
  const toConsole = consoleWriter(format);
  logger = createLogger({
    app: 'web',
    format,
    version: process.env.APP_VERSION ?? 'dev',
    write: (line, level) => toConsole(lineStart + line, level),
  });
  return logger;
}

/** An error line, with the error's stack and the id of the request being handled, if any. */
export function logError(message: string, err: unknown): void {
  log().error(message, { requestId: currentRequestContext()?.requestId, err });
}

/**
 * From now on, each line starts with a newline. Called on SIGTERM, before its line
 * (request-log.server.ts): srvx (Nitro's server) then counts down on stderr until the server has
 * closed, rewriting a line it leaves open until then (`\rStopping server gracefully (5s)...`). A
 * platform that reads stdout and stderr as one stream (Railway) would add the next line to it: one
 * error-level text line, and the JSON line in it lost. Starting with a newline, and ending with
 * one, a line stays whole whichever of the two streams the platform reads first. At worst this
 * leaves an empty line between two lines.
 */
export function newlineBeforeEachLine(): void {
  lineStart = '\n';
}
