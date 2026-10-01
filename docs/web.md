# The web app (`apps/web`)

Details behind the web lines of `AGENTS.md`: how pages get their data, and how UI components are
added.

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
same-origin `/api/graphql`. It rejects with `GraphQLRequestError` (`status`, `errors`) for
top-level GraphQL errors and failed answers; expected failures are union members.

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
BFF's 502) retry up to 3 times. A failed loader or query shows the default error page, whose
"Try again" runs the loaders again (with the API down, SSR answers 500 with that page).

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
