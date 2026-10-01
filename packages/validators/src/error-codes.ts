// The `extensions.code` values clients act on. Safe for browser code: the web forms import these to
// pick their message, and the API and the web server answer with them.

/** The API rejects every mutation (READ_ONLY=true); `Query.readOnly` says so before a write. */
export const READ_ONLY = 'READ_ONLY';
/** The web server refused a write: too many from this client (answered 429 with Retry-After). */
export const RATE_LIMITED = 'RATE_LIMITED';
