# Adding a field or a feature

For people: the order of the layers, what each produces, and the checks that prove a feature end
to end. The step-by-step version, with every rule, file and gotcha, is the skill agents follow:
[`.agents/skills/add-feature/SKILL.md`](../.agents/skills/add-feature/SKILL.md) (in Claude Code:
ask for the feature, or name the skill `add-feature`). Its sibling skills cover the parts that need
more care: `db-migration` (a schema change that takes more than one deploy) and `graphql-change`
(changing a field clients already use).

## Copy the Notes board

The Notes board is the reference for every layer, and `Comment.authorName` is an optional text
field that already crosses all of them: follow it rather than inventing a pattern. Read, in order:
`packages/db/src/schema/notes.ts`, `packages/validators/src/notes.ts`,
`packages/core/src/notes/index.ts`, `apps/api/src/graphql/notes.ts`,
`apps/web/src/lib/notes/queries.ts`, `apps/web/src/components/note-form.tsx`, and
`apps/web-e2e/src/notes.spec.ts`.

## The order

Each layer feeds the next, and each generated file comes from its source through a command, never
a hand edit ([architecture.md](architecture.md#generated-files)).

| #   | Layer      | Where                                   | Produces                                         | Its test                                       |
| --- | ---------- | --------------------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| 1   | Database   | `packages/db/src/schema/*`              | a migration: `pnpm db:generate <what>`           | `packages/db/src/schema.test.ts` (constraints) |
| 2   | Validators | `packages/validators/src/notes.ts`      | the Zod rule and its length limit                | `notes.test.ts` there                          |
| 3   | Core       | `packages/core/src/notes/index.ts`      | the write, a domain error if a rule needs one    | `notes.test.ts` with `testDb()`                |
| 4   | API        | `apps/api/src/graphql/notes.ts`         | `schema.graphql`: `pnpm nx run api:print-schema` | `notes.test.ts` through `yoga.fetch`           |
| 5   | Web data   | `apps/web/src/lib/notes/queries.ts`     | `src/gql`: `pnpm nx run web:codegen`             | typecheck                                      |
| 6   | Web UI     | `apps/web/src/components`, `src/routes` | the form, the card, the page                     | `*.browser.test.tsx`                           |
| 7   | End to end | `apps/web-e2e/src`                      | a spec on the production builds                  | `pnpm nx e2e web-e2e`                          |

Things to know before you start:

- **A column on a table with rows** must be nullable or have a default, or the migration fails on
  the seeded dev database and in production. Read the generated SQL: it must be additive.
- **Optional first.** A new required field breaks deployed clients; add it optional, and make it
  required in a later change.
- **Two pull requests once the app is deployed**: the database, core and API in the first; the
  web operations and UI in the second, after the API is live (a web that selects a field the
  running API lacks fails). Before the first deploy, one pull request is fine.
- **Reads stay on the Drizzle plugin**, writes go through core. A new relation or count goes into
  the API's one-statement test, which catches N+1 queries only in what it selects.
- **Expected failures are union members**, never thrown GraphQL errors; the web forms' exhaustive
  `switch` on `__typename` makes `web:typecheck` fail until a new one is handled.

## Prove it

1. `pnpm regen`, then `git status`: the migration, `schema.graphql` and `src/gql` are part of the
   change, unchanged by hand.
2. `pnpm check` and `pnpm nx e2e web-e2e` pass.
3. Use it: `pnpm dev`, then the form, the board, the note page and a reload in a browser.
4. A pull request with a summary and a test plan (`.github/pull_request_template.md`).

How the tests at each layer work: [testing.md](testing.md).
