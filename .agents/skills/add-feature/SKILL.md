---
name: add-feature
description: 'Use when adding a field or small feature across the stack: db column and migration, Zod validators, core, GraphQL API (print-schema), web operations (codegen) and UI, unit, browser and e2e tests. Gives the order, the regen command for each generated file and the checks that prove it.'
---

# Add a field or feature end to end

<!-- agents:unchecked feat/<x>-api feat/<x>-web -->

Go through the layers in this order. Every generated file comes from its source through the command
named, never from a hand edit. The Notes board is the reference for every layer: copy its patterns
rather than inventing new ones. `Comment.authorName` already crosses every layer as an optional
text field; follow it.

An optional field leaves the repo compiling with its tests green after each step. A required one
turns the tests that create rows (core, API, `note-form.browser.test.tsx`, the e2e `createNote`
fixture) red from step 2 until steps 3-7 give them the field: add it there, never weaken a test.
A new required input also breaks deployed clients (step 4): add the field optional first, and make
it required in a later change. Once the app is deployed, the web selects a new field only after
the API that has it is live (skill `graphql-change`, step 3): steps 1-4 are one PR, and the web's
operations and input keys (steps 5-7) the next. UI wording and identifiers that never reach the
API (a label, a formatter's name, a DOM id) may ship with the API PR. If you cannot tell whether
the app is deployed, assume it is: two PRs, the web one after the API one is live. The first PR's
description says what the next one does (the plan file is gitignored). Put them on two branches:
`feat/<x>-api` (steps 1-4), and `feat/<x>-web` branched from it (steps 5-7), its PR a draft against
the API branch until the API PR is merged and deployed.

## 0. Start

- `pnpm ports` (this checkout's URLs and database), then `pnpm db:seed` (Docker must be running;
  Nx starts and migrates the database first): the dev database has rows before step 1 adds a
  column to them.
- Write a plan in `.agents/ignore/plans/YYYY-MM-DD-<feature>.md`: every layer below the feature
  touches, and the test each one gets.
- Read the reference, in this order:
  1. `packages/db/src/schema/notes.ts`
  2. `packages/validators/src/notes.ts`
  3. `packages/core/src/notes/index.ts`
  4. `apps/api/src/graphql/notes.ts`
  5. `apps/web/src/lib/notes/queries.ts`
  6. `apps/web/src/components/note-form.tsx`, `apps/web/src/components/note-card.tsx`,
     `apps/web/src/routes/notes/$noteId.tsx`
  7. `apps/web-e2e/src/fixtures.ts`, `apps/web-e2e/src/notes.spec.ts`

## 1. Database (`packages/db`)

- Edit `packages/db/src/schema/*.ts` (`packages/db/src/relations.ts` for a new relation). A new
  file there must be exported from `packages/db/src/schema/index.ts`: drizzle-kit and
  `relations.ts` read only the index.
- A column added to a table that already has rows must be nullable or have a default: otherwise
  the migration fails on the seeded dev database, and in production.
- `pnpm db:generate <what>` (letters, digits, `_` and `-`) writes
  `packages/db/migrations/<timestamp>_<what>/migration.sql`. Read the SQL: it must be additive
  (a dropped or renamed column breaks the running app).
- Never edit a migration git tracks (the guard hook blocks it). To redo a new, untracked one that
  was applied: `pnpm db:reset` (wipes this checkout's whole local server: its dev, test and e2e
  databases; it refuses one other checkouts share), delete its folder, fix the schema and
  generate again, then `pnpm db:seed` (it migrates, then seeds). Reseeding before the new
  migration exists fails: the seed writes every column of the schema.
- `pnpm db:migrate` applies it to the seeded dev database. Check the existing rows:
  `pnpm db:psql -c "select count(*), count(author_name) from comments"` (its arguments reach psql
  as written, commas and `=` included: `docs/database.md`).
- Change `packages/db/src/seed.ts` only if the feature needs seeded data, and then `SEED` in
  `apps/web-e2e/src/fixtures.ts` with it (e2e may not import `@acme/db`).
- A constraint or index the schema enforces gets a test in `packages/db/src/schema.test.ts`.

## 2. Validators (`packages/validators/src/notes.ts`)

- Add the rule to the input's Zod schema, and a length limit to `NOTE_LIMITS`: that one value is
  the API's validation and the input's `maxLength`.
- Optional text: `z.string().trim().max(…).nullish().transform((v) => v || undefined)`, as
  `CommentInput.authorName` does: blank and `null` both become "not given".
- Optional with a format (a URL): the same chain, then
  `.pipe(z.url({ protocol: z.regexes.httpProtocol, error: '…' }).optional())`; `httpProtocol`
  also refuses `https:example.com`.
- Tests in `packages/validators/src/notes.test.ts`: the value is accepted and trimmed, blank and
  `null` are dropped, a row in the `length limits` table (the max passes, one more fails with
  `Must be at most N characters`), and the `NOTE_LIMITS` pin for a new limit. A formatted field's
  row turns the `x`s into a valid value of the same length (`'https://x.co/' + v.slice(13)`).
  Prove trimming here: `type="url"` and `type="email"` inputs strip spaces in the browser, so a
  browser or e2e test of it passes either way.

## 3. Core (`packages/core/src/notes/index.ts`)

- Writes go through core, which validates again (`NoteInput.parse`): a field the schema accepts
  reaches the insert with no other change.
- A rule beyond the input's shape (another row must exist) belongs here, as a domain error from
  `packages/core/src/errors.ts` like `NotFoundError`. Let the database decide in one statement, as
  `addComment` does with the foreign key.
- Tests in `packages/core/src/notes/notes.test.ts` use `testDb()` and assert only on rows the test
  created (other tests in the file share its database).
- A filter on a read (a search, a status) is no write: no core function needs it unless another
  app reads the same way. It becomes a Drizzle relational `where` in step 4.

## 4. API (`apps/api/src/graphql`)

- A filter on a read: an optional argument with `validate:` on the connection, turned into a
  relational `where` and passed in its resolve as `query({ where, orderBy })`. The plugin ANDs it
  with its own cursor filter, so the order and the pages hold. Add a case to the one-statement
  test, and an index (skill `db-migration`) when the filter must stay fast on a large table.

- In `notes.ts`, expose the column on the `drizzleObject` (`t.exposeString('x', { nullable: true })`
  for a nullable one) and add it to the input type (`t.string()` is optional). The input's
  `validate:` is the same Zod schema, so its rules and messages apply unchanged.
- `pnpm nx run api:print-schema` rewrites `packages/graphql/schema.graphql`; read its diff. A
  removed field, or an input or argument that became required, breaks deployed clients. Then run
  the API tests: `main.test.ts` fails while `schema.graphql` is stale. Run `pnpm nx run web:codegen`
  too: `apps/web/src/gql` holds only the types operations use, so it changes only when an input
  type an operation already sends gained a field. Commit what it regenerates with the API PR: no
  web code changes in it.
- Reads stay on the Drizzle plugin (`t.relation`, `t.relatedCount`, `query(…)`). Add a new
  relation, count or resolver-backed field to the query of the one-statement test in
  `notes.test.ts`: it catches an N+1 only in what it selects. `complexity.test.ts` checks only
  connections: a list relation needs its own `complexity`, as `comments` has, and a case in the
  pricing test in `notes.test.ts`.
- A new failure mode is a union member: register its class in `error-types.ts` and add it to the
  mutation's `errors: { types: [...] }`. Never throw it as a GraphQL error (`docs/api.md`).
- Tests in `apps/api/src/graphql/notes.test.ts` (through `yoga.fetch`): the field in a query, the
  mutation storing it, and a `ValidationError` whose `fieldErrors` has `path: ['input', 'x']`.

## 5. Web data (`apps/web/src/lib/notes/queries.ts`)

- Select the field in each `graphql()` operation that shows it: `NotesQuery` (the board),
  `NoteQuery` (the note page). Operations live in `src`, never in a test file (codegen skips tests).
- `pnpm nx run web:codegen` regenerates `apps/web/src/gql` (`pnpm dev` does it on save). Until it
  runs, the new field is a type error.
- Fix every type error that follows (`pnpm nx run web:typecheck`), such as the typed test data
  (`NotesQuery`, `NoteQuery` in `src/notes.browser.test.tsx`). A new union member fails a form's
  exhaustive `__typename` switch at `unreachable(result)`: handle it there.
- Typecheck does not flag a field missing from `NoteSummary` in `note-card.tsx` (a query node
  with more fields still fits it): add a field the card shows to it by hand.

## 6. Web UI (`apps/web/src/components`, `apps/web/src/routes`)

- Page state that belongs in the URL (a search, a filter, a tab): `docs/web.md`, "State in the
  URL" (`validateSearch`, `loaderDeps`, how the router parses values).

- A form field: copy one from `note-form.tsx` (`comment-form.tsx` has an optional one). `Field`,
  `FieldLabel` and `FieldError`; `name` is the input's key; `maxLength` from `NOTE_LIMITS`;
  `aria-invalid` and `aria-describedby`; the name added to `FIELDS`, so its errors land on it. The
  steps of a write: `docs/web.md`, "Writes: forms".
- A write without a form (a toggle, a button): `docs/web.md`, "Writes without a form". It sends
  the state to set, never "toggle"; stays pending until its invalidations have refetched; toasts
  its result, and a write that threw (`useWriteError()`); and is disabled while read-only, while
  pending and until hydration. Its browser test clicks it, and asserts the input sent and each
  toast.
- Show values as React text only, never HTML (`wrap-anywhere` on user text). A formatter (a
  fallback such as "Anonymous") goes in `src/lib/notes/format.ts`, with node tests in
  `format.test.ts`.
- A user URL becomes an `href` only through an http(s) guard in `format.ts` (whatever the database
  holds), with `target="_blank"` and `rel="noopener noreferrer"`. Its browser test pins `target`
  and `rel`, and shows that a stored `javascript:` value renders no link.
- After a write, invalidate the `noteKeys` of every query that shows the field (`noteKeys.lists()`
  for the board, `noteKeys.detail(id)` for a note) in the mutation's options-level `onSuccess`.
- A new route file: `pnpm nx run web:generate-routes` regenerates `src/routeTree.gen.ts`. Loaders
  `await ensure…()` and return nothing; components `useSuspense…` the same options.
- Browser tests sit next to the component (`*.browser.test.tsx`, `pnpm nx run web:test-browser`).
  Mock `execute()` as `note-form.browser.test.tsx` does; assert the input sent
  (`toHaveBeenCalledExactlyOnceWith(CreateNoteDocument, { input })`, which ignores keys that are
  `undefined`: `{ title, body }` proves a blank optional field was not sent) and a field error
  from a `ValidationError`. Board and note page: `src/notes.browser.test.tsx`.
- Find fields by their exact label, as the existing tests do:
  `getByRole('textbox', { name: 'X', exact: true })`. Without `exact`, a name matches every label
  that contains it, in any case (a new "Subtitle" field would make each `Title` query find two).

## 7. e2e (`apps/web-e2e/src`)

- A new `src/<feature>.spec.ts`, or a test in `notes.spec.ts`, importing `test` and `expect` from
  `./fixtures`.
- Each test creates its own rows: `uniqueTitle()` and the `createNote` fixture. Never change a
  seed note, never assert on rows other tests may add (`docs/e2e.md`).
- Add the new field to the fixture only when a spec creates such rows through the BFF, and then in
  its input type, in the `input` it sends and in the mutation's selection (typecheck passes when
  the `input` sent leaves it out).
- Check the board, the note page and a reload (server-rendered, no client cache), by role and
  label, `exact: true` as in step 6.
- `pnpm nx e2e web-e2e` runs every spec on the production builds; one file:
  `pnpm nx e2e web-e2e -- src/<feature>.spec.ts`. One e2e run per checkout at a time.

## 8. Docs

- Update `docs/web.md`, `docs/api.md`, `docs/e2e.md` or `docs/database.md` when a rule changes (a field alone changes
  none).
- Touch `AGENTS.md` only for a new rule, and replace text rather than add: it is capped at 12,000
  bytes and 200 lines, and `pnpm check` fails above that.

## 9. Prove it

- `pnpm regen`, then `git status`: the migration, `schema.graphql`, `src/gql` (and
  `routeTree.gen.ts`) are in the change, regenerated and unchanged by hand.
- `pnpm check` and `pnpm nx e2e web-e2e` pass. `pnpm check` passes with lint warnings: read the
  ones in the files you changed.
- Use it: `pnpm dev` in the background (`WRITE_RATE_LIMIT=off pnpm dev` for scripted writes).
  Check the web's `/api/health` and the API's `/health` (URLs from `pnpm ports`) with
  `curl -fsS -o /dev/null -w "%{http_code}\n" <url>`: the API answers with an empty body. Then
  drive a browser as `docs/e2e.md` shows ("Driving the app by hand", the web URL from
  `pnpm ports`): the form → the board → the note page → a reload.
- One PR (two once the app is deployed: above) with a summary and a test plan, then the review
  loop (skill `review-loop`).

## Gotchas

- Generated files are read-only: `packages/graphql/schema.graphql`, `apps/web/src/gql/**`,
  `apps/web/src/routeTree.gen.ts`, tracked migrations, `.claude/skills/**`. `.agents/generated.json`
  names each one's regen command.
- Nullable GraphQL inputs arrive as `null`, not `undefined`: the Zod schema needs `.nullish()`.
- Tests that touch the database use `testDb()` from `@acme/db/testing`.
- Test files stay out of `src/routes` (the route generator reads every file there).
- An operation is a type error until `web:codegen` runs, and `graphql()` returns no document for
  it (`execute()` rejects, naming `web:codegen`).
- The write rate limit is on in dev (`WRITE_RATE_LIMIT`, `docs/web.md`); e2e turns it off itself.
- `pnpm regen` runs `db:db-generate` without a name: a pending schema change gets a random
  migration name. Run `pnpm db:generate <what>` first.
