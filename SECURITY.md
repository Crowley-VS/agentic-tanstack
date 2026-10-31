# Security policy

This policy covers the agentic-tanstack template: its code, its defaults and its documentation. A
project made from the template is its owner's: report a problem in someone's deployment to them.

## Supported versions

| Version                    | Supported                  |
| -------------------------- | -------------------------- |
| `main`                     | yes: fixes land here first |
| the latest release (`0.x`) | yes                        |
| older releases             | no: update to the latest   |

Releases are tagged `vX.Y.Z` (`CHANGELOG.md`). Projects made from the template take fixes by hand:
`docs/updating-from-template.md`.

## Reporting a vulnerability

Report it **privately**, through GitHub's private vulnerability reporting: the repository's
**Security** tab, then **Report a vulnerability**
(`https://github.com/Crowley-VS/agentic-tanstack/security/advisories/new`). Never in a public issue,
discussion or pull request.

Include what an attacker can do, the steps or a proof of concept, the commit or version, and the
configuration it needs (production or development, the environment variables involved). The
conversation stays in the private advisory; once a fix is out, the advisory is published, crediting
you unless you ask otherwise.

A vulnerability in a dependency belongs upstream; tell us too if the template's defaults make it
reachable.

## There is no authentication

**The template has no authentication, on purpose.** Its reference feature, the Notes board, is a
public, create-only demo: anyone who can reach the web server can read every note and create notes
and comments. That is not a vulnerability. Before you rely on public writes (or keep anything
private), add authentication and authorization: `docs/decisions/0012-adding-auth.md` shows where
they plug in.

What the demo has instead are abuse controls, none of which is access control:

- input limits (Zod schemas in `packages/validators`, checked by the API and again in core);
- the BFF (`POST /api/graphql`) accepts only JSON bodies of at most 64 KB and limits writes per
  client IP (`WRITE_RATE_LIMIT`, default 10 a minute; in memory, per process);
- query depth, alias, token and cost limits (graphql-armor, Pothos complexity);
- `READ_ONLY=true` on the API rejects every mutation (an incident switch);
- user text renders as React text only, never as HTML.

## What the API locks down by default

The API (`apps/api`, details in `docs/api.md`) is private: only the web server calls it, and tests
pin each of these defaults.

- **No public address.** On Railway it has no domain; the browser reaches it only through the web
  server's same-origin BFF, which adds the secret on the server and relays only the API's status,
  body and content type (no API cookie or CORS header).
- **A shared secret.** In production every request but `/health` must carry
  `INTERNAL_API_SECRET` (32+ characters), compared in constant time; without it the API refuses to
  start. The client IP and request id the web server forwards are believed only with the secret.
- **Production hardening.** Introspection, GraphiQL and field suggestions are off; unexpected
  errors are masked (`Unexpected error.`, details in the server log); CORS is off and CSRF
  prevention on.
- **Limits** on depth (10), aliases (15), directives (10), tokens (2,000) and cost (5,000 in
  graphql-armor's measure), checked before execution; the schema checks depth (10) and complexity
  (2,000) again before its first resolver runs.

## Secrets

- Secrets live only in `.env` (gitignored; bootstrap writes it with a generated
  `INTERNAL_API_SECRET`) and in your platform's variables. Never commit them: git ignores every
  `.env*` file but `.env.example`, which must never hold a real secret.
- Agents are denied reading `.env*` (`.claude/settings.json`).
- The secret never reaches the browser: server code lives in `*.server.ts` files, and the web
  build fails when the client bundle contains server-only code, the secret's name or its value
  (`apps/web/scripts/check-client-bundle.mjs`).

## Supply chain

pnpm installs no version published less than 24 hours ago (`minimumReleaseAge`), runs install
scripts only for the packages `allowBuilds` lists, and installs from a frozen lockfile in CI and the
images. Versions come from one catalog in `pnpm-workspace.yaml`, pinned exactly where compatibility
is tight.
