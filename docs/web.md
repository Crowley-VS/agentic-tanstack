# The web app (`apps/web`)

Details behind the web lines of `AGENTS.md`: how pages get their data, how the BFF and the error
page fail, and how UI components are added.

## Operations are typed by codegen

Write every operation with `graphql()` from `src/gql`, anywhere in `src` except tests. GraphQL Codegen
(`pnpm nx run web:codegen`) types them from `packages/graphql/schema.graphql` into `src/gql`
(committed, generated). Until it runs, a new or edited operation is a type error, and `graphql()`
returns no document for it at runtime (`execute()` rejects it, naming `web:codegen`). `pnpm dev`
regenerates on save (`web:codegen-watch`: `nx watch` on api, web and their dependencies re-runs
`web:codegen`, which re-prints the API schema first; it needs the Nx daemon, so it turns it on where
Nx defaults it off, in CI or Docker; with `NX_DAEMON=false` it exits and you run `web:codegen`
yourself). The `eslint` target checks operations against the schema (`@graphql-eslint`,
operations-recommended) and reports the real file and line.

## One executor: `execute()`

`execute(document, variables, { signal })` (`src/lib/graphql/execute.ts`) resolves to the typed
`data`. Variables may be left out when every one is optional (or there are none). On the server
(SSR, loaders) it calls the API directly with the internal secret; in the browser it posts to the
same-origin `/api/graphql`. It rejects with `GraphQLRequestError` (`src/lib/graphql/errors.ts`:
`status`, `errors`, `code` from the first error's `extensions.code`, `retryAfter` from a
`Retry-After` header) for top-level GraphQL errors and failed answers. On the server, an API that
never answers fails like the BFF does: 502 `API unavailable` (also for an invalid web
environment) or 504 `API timed out`, with the cause kept for the log. In the browser, network
failures and aborts reject as `fetch` does. Expected failures are union members.

## Loaders fill the cache, components read it

```tsx
const noteOptions = (id: string) =>
  queryOptions({
    queryKey: ['note', id],
    queryFn: ({ signal }) => execute(NoteQuery, { id }, { signal }),
  });

export const Route = createFileRoute('/notes/$id')({
  // awaited: the data is in the SSR HTML; returned data would be serialized a second time
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(noteOptions(params.id));
  },
  component: NotePage,
});

function NotePage() {
  const { data } = useSuspenseQuery(noteOptions(Route.useParams().id));
  return <h1>{data.note?.title}</h1>;
}
```

Every request gets its own `QueryClient` (`src/router.tsx`), dehydrated into the page and hydrated
in the browser. `staleTime` is 30 s, so hydration never refetches. Queries never retry on the
server, nor for GraphQL errors in a 2xx or 4xx answer; other failures (network, 5xx such as the
BFF's 502) retry up to 3 times. A failed loader or query shows the error page
(`src/components/error-page.tsx`), whose "Try again" runs the loaders again (with the API down,
SSR answers 500 with that page). It logs what failed a server render, with its cause, and shows a
fixed message chosen from the error's message alone (an SSR error reaches the browser as a plain
`Error`, so a class check would break hydration): the raw message in development only.

## The BFF: `POST /api/graphql`

The browser's only way to the API (`src/server/graphql-proxy.server.ts`). It takes same-origin JSON
POSTs (else 415) of at most 64 KB (else 413), limits writes (else 429), adds the internal secret,
and relays the API's status and body with only its content type: no API cookie or CORS header
reaches the browser. Every other method gets 405 from an `ANY` handler (`/api/health` has one too):
without one, Start answers it with the page renderer's 200 HTML. In production the server needs
`API_HOST` (a bare host name or IP) and `API_PORT`: there is no fallback to this machine, and
`/api/health` answers 503 without them.

- **Write rate limit** (`src/server/rate-limit.server.ts`). At most `WRITE_RATE_LIMIT` writes per
  client IP (IPv6: per /64) in a window opened by the client's first write: `<writes>/<n>[smh]`,
  default `10/60s`, on everywhere including `pnpm dev` (set `WRITE_RATE_LIMIT=off` for scripted
  writes); `off` or `E2E=1` (the e2e servers) turns it off. Only a body that surely runs a query
  is free: a mutation, or anything the BFF cannot classify (bad JSON, a batch, a persisted query,
  a syntax error, an unclear `operationName`), counts; a body refused with 413 or 415 does not.
  Over the limit: 429 with `Retry-After` and the error `Too many writes: try again in N s.` with
  `extensions.code: RATE_LIMITED` (from `@acme/validators/error-codes`); `execute()` rejects with
  a `GraphQLRequestError` whose `code` and `retryAfter` say so. Counts live in memory, per
  process: N instances allow N times the limit, and a restart resets them; a shared store (e.g.
  Redis) or the edge is the upgrade.
- **Client IP.** What the write rate limit counts by, and sent to the API as `x-client-ip` for
  its log: the address in `REAL_IP_HEADER` (default `x-real-ip`) when it holds an IP, else the
  socket's address; never `X-Forwarded-For`. Name the header the proxy in front overwrites; with
  no proxy in front, set it empty, or clients can claim any address (and dodge the limit).
- **Request id.** The browser's or the edge's `x-request-id` when it is short and plain, else a
  new UUID. It goes to the API (`x-request-id`), back to the browser, and into the web server's
  error lines. SSR calls get a new one each.
- **Failures.** API unreachable: 502 `API unavailable`; no answer within 10 s: 504
  `API timed out` (both logged with the request id). A browser that leaves gets a 499 nobody
  reads and no log line; Start itself still logs the request's `AbortError` once.

## UI components come from the shadcn CLI

`packages/ui/src/components` holds shadcn/ui components, written by the pinned CLI, never by hand:

```sh
pnpm --filter @acme/ui exec shadcn add <name> --overwrite   # --dry-run lists what it would write
pnpm format
git diff packages/ui                                         # then restore any local edit it lost
```

Many components bring others along (`alert-dialog` brings `button`), and `pnpm format` has
restyled the ones already here, so the CLI asks before overwriting them. Without a terminal (an
agent's shell) it cannot ask: it exits 0 having written nothing, not even the new component. With
`--overwrite` it rewrites them, `pnpm format` restyles them, and `git diff` shows only real
changes: a newer registry version, or a local edit the registry copy dropped (today only the
`toast` re-export at the end of `sonner.tsx`). New files show in `git status`.
