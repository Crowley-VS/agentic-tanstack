# The web app (`apps/web`)

Details behind the web lines of `AGENTS.md`: how to run it, how pages get their data, how forms
write it, how the BFF and the error page fail, how components are tested, and how UI components
are added.

## Run it

| Task                                  | Command                                                          |
| ------------------------------------- | ---------------------------------------------------------------- |
| Web + API dev servers (reloading)     | `pnpm dev` in the background; curl `/api/health` + API `/health` |
| Production build / run it             | `pnpm nx run web:build` / `pnpm nx run web:serve`                |
| After adding or renaming a route file | `pnpm nx run web:generate-routes` (or `pnpm regen`)              |
| After editing a `graphql()` operation | `pnpm nx run web:codegen` (`pnpm dev` does it on save)           |

The health check is `/api/health` (it also answers the deployed `version`); `pnpm ports` prints
the URLs. Every request Start handles gets one log line (`src/start.ts`; JSON in production:
`docs/production.md`). A production server needs `INTERNAL_API_SECRET`, `API_HOST` and
`API_PORT` (`web:serve` takes the last two from this checkout's ports; see the BFF below).
`web:serve` listens on 127.0.0.1 unless `NITRO_HOST` says otherwise (`NITRO_HOST=0.0.0.0` to
reach it from another device; `HOST` is ignored there); in a container (`docs/deployment.md`)
Nitro listens on every interface. Writes are rate-limited per client IP, in `pnpm dev` too
(below). `web:test` runs `web:build` first: `src/built-server.test.ts` runs the production build
as a process and stops it with SIGTERM (`docs/production.md`, Shutdown).

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

The Notes board is the reference: its operations, query keys (`noteKeys`, broad to narrow, for
invalidation) and query options live in `src/lib/notes/queries.ts`; the routes are
`src/routes/index.tsx` (an infinite query with "Load more") and `src/routes/notes/$noteId.tsx`:

```tsx
// src/lib/notes/queries.ts
export const noteOptions = (id: string) =>
  queryOptions({
    queryKey: noteKeys.detail(id),
    queryFn: ({ signal }) => execute(NoteQuery, { id }, { signal }),
  });

// src/routes/notes/$noteId.tsx
export const Route = createFileRoute('/notes/$noteId')({
  // awaited: the data is in the SSR HTML; returned data would be serialized a second time
  loader: async ({ context, params: { noteId } }) => {
    if (!NoteId.safeParse(noteId).success) throw notFound(); // no API call for a malformed id
    const { note } = await context.queryClient.ensureQueryData(noteOptions(noteId));
    if (!note) throw notFound();
  },
  // head() reads the cache the loader filled
  head: ({ match, params }) => {
    const note = match.context.queryClient.getQueryData(noteOptions(params.noteId).queryKey)?.note;
    return { meta: [{ title: `${note?.title ?? 'Note not found'} · acme-app` }] };
  },
  component: NotePage,
});

function NotePage() {
  const { note } = useSuspenseQuery(noteOptions(Route.useParams().noteId)).data;
  // …
}
```

Every request gets its own `QueryClient` (`src/router.tsx`), dehydrated into the page and hydrated
in the browser. `staleTime` is 30 s, so hydration never refetches. Queries never retry on the
server, nor for GraphQL errors in a 2xx or 4xx answer; other failures (network, 5xx such as the
BFF's 502) retry up to 3 times. A failed loader or query shows the error page
(`src/components/error-page.tsx`), whose "Try again" runs the loaders again (with the API down,
SSR answers 500 with that page). It logs what failed a server render, with its cause, and shows a
fixed message chosen from the error's message alone (an SSR error reaches the browser as a plain
`Error`, so a class check would break hydration): the raw message in development only. The
message is in the page's dehydrated state either way, so keep server detail in `cause`.
`notFound()` (an unknown URL, a malformed or missing id) renders `src/components/not-found.tsx`
with HTTP 404; a route may pass it its own message.

The root loader fills `appStatusOptions()` (`src/lib/app-status.ts`) for every page:
`Query.readOnly`, true while the API runs with `READ_ONLY=true`. `useReadOnly()` reads it, and the
root layout shows a banner while it is true. With the API down, the root loader fails, so the
error page renders without the layout, for every URL: an unknown URL or a malformed note id
answers 500 then, not 404.

Hydration-safe rendering:

- Buttons that need JavaScript ("Load more", a form's submit, a write without a form, the error
  page's "Try again") render disabled until `useHydrated()`: a click before hydration would be
  lost (a submit would be a native GET, with the form's fields in the URL). Playwright waits for
  them to be enabled, so e2e specs need no hydration retries. "Load more" also stays disabled while
  any fetch runs or is paused (offline).
- User text renders as React text only (never `dangerouslySetInnerHTML`); long words wrap
  (`wrap-anywhere`) and bodies keep their line breaks (`whitespace-pre-wrap`).
- Timestamps are UTC text (`formatTimestamp()` in `src/lib/notes/format.ts`): the server and
  every browser render the same string, whatever their time zone or locale.

## Writes: forms

The board's "New note" form (`src/components/note-form.tsx`) is the reference; copy it for a new
write (`comment-form.tsx` is the same with a `NotFoundError` case; a write with no form: below).
Its mutation lives with the board's operations (`src/lib/notes/queries.ts`); the helpers are in
`src/lib/forms.ts`:

1. **Validate in the browser** with the API's own Zod schema (`NoteInput` from
   `@acme/validators/notes`): the same rules and messages, and nothing is sent while a field is
   invalid. `fieldErrors()` maps the issues to the fields (the first message per field wins).
   Inputs are uncontrolled (`name` attributes, `maxLength` from `NOTE_LIMITS`), read with
   `FormData` before the mutation starts: the disabled fieldset leaves its fields out of it.
2. **Send** with `execute()` inside `useMutation` (the pending state disables the fieldset and
   marks the button `aria-busy`).
3. **Handle the result** with an exhaustive `switch` on `__typename` that ends in
   `setErrors({ form: unreachable(result) })`: a union member the API adds later fails
   `web:typecheck` there; at run time (an API deployed ahead of the web) it logs the result and
   the form shows the generic message. A `ValidationError` maps to the fields with
   `fieldErrors(…, { argument: 'input' })`; the input stays, so it can be fixed.
4. **On success**, the options-level `onSuccess` returns the `invalidateQueries` promise for every
   query that shows the new data (by `noteKeys`), so the form stays pending until they have
   refetched (a per-call `onSuccess` is not awaited); then the form resets and a toast says so.
   A query no component on the page reads (the board's list, from a note's page) needs
   `refetchType: 'all'`: a plain invalidation only marks it stale, and going back shows old data.

A write that throws shows one message under the form (`useWriteError()`): read-only (`READ_ONLY`
from the API; it also sets the cached `appStatus` to read-only, so the banner shows and every form
disables), `Too many writes: try again in N s.` (the BFF's 429 `RATE_LIMITED`, N from
`Retry-After`; "in a moment" without one), or a generic one (network, masked errors). Both codes
come from `@acme/validators/error-codes`. Forms render disabled while `useReadOnly()` is true, and
their submit button until hydration.

The forms use plain React state: two short forms, with every step visible to copy.
`@tanstack/react-form` is the upgrade for bigger forms; it is not added while its 2.0 is in alpha
(1.33.5 is current).

## Writes without a form

A write from a single control (a toggle, a delete or "mark done" button) takes the forms' steps
without the fields, and has no form to show a message under:

1. **Send the state to set**, never "toggle" (`{ noteId, done: true }`, the opposite of what the
   page shows): a retry or a double click then cannot flip it back. The API still validates it
   with its Zod schema, in the mutation's `validate:` and again in core.
2. **Wait for the invalidations**: the options-level `onSuccess` returns the `invalidateQueries`
   promise, as a form's does, so the control stays pending (disabled, `aria-busy`) until every
   query that shows the change has refetched (`refetchType: 'all'` for one no component on the
   page reads). No optimistic update: the page shows only what the API stored.
3. **Toast the result**: success says what changed; another union member (a `NotFoundError`, a
   `ValidationError`'s first message) is an error toast, and `unreachable(result)` gives the
   message for one it does not know. A write that threw is a toast of `useWriteError()`'s message
   (read-only, rate-limited or generic, as for forms).
4. **Disable it** while `useReadOnly()` is true, while pending, and until `useHydrated()`.

Its accessible name says what it acts on when there are several on a page (one per card); a
toggle keeps one name and shows its state with `aria-pressed`. On a card it sits above the title
link, which covers the card (`src/components/note-card.tsx`), so a click on it does not open the
note. Browser tests mock `execute()` as for forms: the input sent, each toast, and the disabled
states.

## Browser tests

Component tests run in real Chromium (`*.browser.test.tsx`, `pnpm nx run web:test-browser`),
installed once per machine and after each Playwright bump (`pnpm exec playwright install chromium`).
Watch them in a visible browser: `HEADED=1 pnpm nx run web:test-browser --skip-nx-cache --watch`.

- Mock `execute()`'s module with a plain `vi.mock` factory that returns `{ execute: vi.fn() }`:
  without Start's compiler it would take its server branch, and a factory that calls
  `importOriginal` loads its server imports (`node:async_hooks`). `GraphQLRequestError` stays
  real (`src/lib/graphql/errors.ts` has no framework imports), so tests throw the real thing.
- A form reads the app status: seed `appStatusOptions()` in the `QueryClient` before rendering
  (`queryClient.setQueryData(appStatusOptions().queryKey, { readOnly: false })`).
- A new `Toaster` shows the toasts still active (sonner keeps them in module state): call
  `toast.dismiss()` after each test.
- The app's stylesheet is loaded (`vitest.browser.config.ts`), so `toBeVisible()` and disabled
  styles are real. Tailwind scans `src` without the tests, so a class used only in a test is not
  generated.
- `src/components/note-form.browser.test.tsx` shows a form; `src/notes.browser.test.tsx` a page,
  with a small in-memory router for links.

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
  is free: a mutation counts one write per root field (aliases included, through fragments, so
  `mutation { a: createNote(…) b: createNote(…) }` is 2), and anything the BFF cannot classify
  (bad JSON, a batch, a persisted query, a syntax error, more tokens than the API accepts
  (`MAX_TOKENS` from `@acme/validators/internal-api`), an unclear `operationName`) counts 1; a
  body refused with 413 or 415 does not. A request that would go past the limit is refused whole.
  Over the limit: 429 with `Retry-After` and the error `Too many writes: try again in N s.` with
  `extensions.code: RATE_LIMITED` (from `@acme/validators/error-codes`); `execute()` rejects with
  a `GraphQLRequestError` whose `code` and `retryAfter` say so. Counts live in memory, per
  process: N instances allow N times the limit, and a restart resets them; a shared store (e.g.
  Redis) or the edge is the upgrade.
- **Client IP.** What the write rate limit counts by, and sent to the API as `x-client-ip` for
  its log: the address in `REAL_IP_HEADER` (default `x-real-ip`) when it holds an IP, else the
  socket's address; never `X-Forwarded-For`. Name the header the proxy in front overwrites; with
  no proxy in front, set it empty, or clients can claim any address (and dodge the limit). A value
  that is no header name fails `/api/health` (503), not every request.
- **Request id.** The edge's id for the request (`EDGE_REQUEST_ID_HEADER`, default Railway's
  `x-railway-request-id`), else a short, plain `x-request-id`, else a new UUID; worked out once
  per request (`src/server/request-context.server.ts`), so a page's SSR calls to the API carry the
  page request's id and client IP too. It goes to the API (`x-request-id`), back to the browser
  (on every answer: relayed ones and the BFF's own 429, 502 and 504), and into the web server's
  lines (`docs/production.md`).
- **Failures.** API unreachable: 502 `API unavailable`; no answer within 10 s: 504
  `API timed out` (both logged with the request id). A browser that leaves gets a 499 nobody
  reads (its request line says 499); Start itself still logs the request's `AbortError` once.

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
