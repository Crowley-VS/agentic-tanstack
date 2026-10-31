# 0012 — No authentication in the template, and where to add it

- **Status:** accepted (2026-09-29)
- **Applies to:** `apps/web/src/server`, `apps/web/src/lib/graphql/execute.ts`, `apps/api/src/app.ts`,
  `packages/core`, `packages/validators/src/internal-api.ts`

## Context

Every product authenticates differently: email links or passwords, OAuth, SSO, organizations and
roles, API keys for partners. A template that picks one makes everyone else rip it out, and a
half-finished auth that people trust because it came with the template is worse than none. The
reference feature (the Notes board) is therefore a **public, create-only demo**: anyone who can
reach the web server can read every note and add notes and comments.

## Decision

- The template ships **no authentication or authorization**. It ships abuse controls instead
  (input limits, a write rate limit per client IP, query cost limits, `READ_ONLY=true`), which are
  not access control. Add auth before relying on public writes.
- The request path is built so auth has one place to go in each layer. This record names them.

## Where auth plugs in

The path today: the browser calls the web server only (`POST /api/graphql`, and the pages it
renders); the web server calls the private API with `INTERNAL_API_SECRET`; the API calls core with
a database handle ([architecture.md](../architecture.md)).

1. **Sessions live in the web server.** Sign-in and sign-out are Start server routes (next to
   `src/routes/api/graphql.ts`) or server functions, from the auth library you choose. The session
   is an HttpOnly, Secure, `SameSite=Lax` cookie on the web origin; users and sessions are tables in
   `packages/db` (skill `db-migration`). The browser never talks to the API, so the API needs no
   cookie handling at all.
2. **Resolve the session once per request.** `src/server/request-context.server.ts` already works
   out a request id and client IP once per request and shares them with the BFF, the request log and
   SSR's API calls (`execute()` reads them through `currentRequestContext()`). Add the signed-in
   user there, so every API call a request makes carries the same identity.
3. **Forward the identity to the API, server to server.** `callInternalApi()`
   (`src/server/internal-api.server.ts`) builds the API request's headers from scratch: the secret,
   the client IP and the request id; no browser header (cookie, `Authorization`) passes through the
   BFF. Add one more, say `x-user-id`, defined next to `CLIENT_IP_HEADER` in
   `packages/validators/src/internal-api.ts`, the contract both sides import. A browser cannot set
   it, because the BFF never forwards its headers. If you do not trust the private network, forward
   a short-lived signed token instead and verify it in the API.
4. **The API believes it only with the secret.** `apps/api/src/app.ts` builds the GraphQL context
   (`context: () => ({ db, readOnly })` today), and `fromWebServer(env.INTERNAL_API_SECRET)`
   (`plugins/internal-secret.ts`) is how the request log already decides whether to believe the
   forwarded client IP. Read the identity header in the context factory only when that check passes
   (`context: ({ request }) => …`); otherwise the request is anonymous. With no secret set (allowed
   in development), nothing forwarded is believed: keep the generated secret in `.env`.
5. **Authorization lives in core.** Core functions take a database handle and plain input, never a
   request (`createNote(db, input)`). Give the ones that need it the actor as a plain value
   (`createNote(db, actor, input)`), check the rule there, and throw a domain error from
   `packages/core/src/errors.ts` (as `NotFoundError` is today). The API maps it to a union member
   (`error-types.ts` and the mutation's `errors: { types: [...] }`), so clients handle it by
   `__typename` and the web forms' exhaustive `switch` fails `web:typecheck` until they do. Reads
   filter by the viewer in the Drizzle plugin's `query(…)`; for field-level rules,
   `@pothos/plugin-scope-auth` is the Pothos way.
6. **The web app shows it.** A `Query.viewer` field for the UI, a route guard in the loaders
   (`beforeLoad` or the loader throws a redirect), a sign-in page. Rate-limit writes per user as
   well as per IP (`src/server/rate-limit.server.ts`).

## Consequences

- Nothing in the template pretends to protect data: every visitor is anonymous, and the docs say
  so (the README, `SECURITY.md` in the template repository, this record).
- Adding auth is additive: one header in the internal contract, one context field, an actor
  parameter in core, union members in the API, and tests at each step: core tests for the rules,
  API tests that send the header with the secret (believed) and without it (ignored), and an e2e
  fixture that signs in through the web server.
- CSRF stays covered for the BFF: it accepts only `application/json` bodies, which a cross-site page
  can send only after a CORS preflight the web server never approves. Sign-in routes that take form
  posts need their own check (the `Origin` header, or the library's CSRF token); `SameSite=Lax`
  helps.
- Keep the rules that make this safe: the browser never calls the API, the secret never reaches the
  browser (`*.server.ts`, the client-bundle check), and forwarded headers are believed only with
  the secret.

## Alternatives considered

- **Ship one auth (Better Auth, Auth.js, Lucia-style sessions, a hosted provider)**: right for some
  products and wrong for the rest; whichever it is, most forks would replace it or trust it without
  reading it.
- **Auth in the API** (the browser sends a bearer token to the API): would need the API public, CORS
  and token handling in the browser; the BFF keeps tokens and the secret on the server.
- **Basic auth or an IP allowlist in front**: fine to hide a staging deploy, not a user model.
