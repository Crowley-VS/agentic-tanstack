// Logging from code that renders on both sides (components): on the server a line in the web
// server's log, tagged with the request id; in the browser nothing (its console shows the error
// already). The Start compiler drops the server branch and its imports from the client bundle.
import { createIsomorphicFn } from '@tanstack/react-start';
import { logError } from '../server/log.server';

/** Logs a failure while the server renders a page, with its stack and the request id. */
export const logServerError = createIsomorphicFn()
  .server((message: string, err: unknown) => logError(message, err))
  .client(() => {});
