// Start's instance options (Start finds this file by its name): the request middleware that runs
// around every request Start handles (pages, server routes, server functions). Their code lives in
// *.server.ts modules: the compiler drops each `.server()` body, and the imports only it uses,
// from the client bundle (web:build's bundle check fails otherwise).
import { createMiddleware, createStart } from '@tanstack/react-start';
import { logRequest } from './server/request-log.server';

/** One log line per request, and the request id on the answer (server/request-log.server.ts). */
const requestLog = createMiddleware({ type: 'request' }).server(({ request, next }) =>
  logRequest(request, next),
);

export const startInstance = createStart(() => ({ requestMiddleware: [requestLog] }));
