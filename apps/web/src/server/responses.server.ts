// The web server's own error answers on /api/*, in GraphQL's response shape ({ errors: [...] }), so
// execute() and the UI read a BFF refusal (405, 413, 415, 429, 502, 504) like an error from the
// API; `extensions.code` tells one refusal from another (429: RATE_LIMITED).

type ErrorInit = { headers?: Record<string, string>; extensions?: Record<string, unknown> };

export const errorResponse = (
  status: number,
  message: string,
  { headers, extensions }: ErrorInit = {},
) =>
  Response.json({ errors: [{ message, ...(extensions && { extensions }) }] }, { status, headers });

/**
 * 405 for a method a server route does not serve. A route needs an `ANY` handler that answers
 * this: without one, Start sends the method to the page renderer, which answers 200 HTML.
 */
export const methodNotAllowed = (allow: string) =>
  errorResponse(405, `Method not allowed: use ${allow}`, { headers: { allow } });
