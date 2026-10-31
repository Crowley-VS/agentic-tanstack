---
name: db-migration
description: 'Use when changing the database schema in packages/db/src/schema: a table, column, index or constraint. Gives the steps from the schema edit to a named migration, the dev database, seed and tests, and the expand/contract rules that keep a deploy from breaking the running app.'
---

# Change the database schema

Read `docs/database.md` first. A new field that crosses every layer (validators, core, API, web)
follows skill `add-feature`; this skill is its database part, plus what to do when a change is not
purely additive.

## 0. Start

- `pnpm ports` (this checkout's database), then `pnpm db:seed` (Docker must run; Nx starts and
  migrates the database first): the dev database has rows before your migration meets them.
- Read `packages/db/src/schema/notes.ts` (uuidv7 ids, millisecond timestamps, an index for each
  sort order and foreign key) and `packages/db/src/relations.ts`.
- Decide how many deploys the change takes (step 5) before you write it.

## 1. Edit the schema

- Edit `packages/db/src/schema/*.ts`. A new file is exported from `packages/db/src/schema/index.ts`
  (drizzle-kit and `relations.ts` read only the index); a new relation goes in
  `packages/db/src/relations.ts`.
- A column added to a table with rows is nullable or has a default: a `NOT NULL` column without
  one fails the migration on the seeded dev database, and in production.

## 2. Generate the migration and read it

- `pnpm db:generate <what>` writes `packages/db/migrations/<timestamp>_<what>/migration.sql` and
  its `snapshot.json`. `<what>` is letters, digits, `_` and `-` (`add_tags`); the command refuses
  any other name or option (`--help` lists its few). Always name it: `pnpm regen` runs the
  generator without a name, so a pending change gets a random one.
- Read the SQL. Except in the contract step of an expand/contract change, it only adds (tables,
  nullable or defaulted columns, indexes) or relaxes (a dropped `NOT NULL` or check); a column
  drop's first deploy replaces its generated `DROP COLUMN`, and a `DROP TABLE` waits for the
  second (step 5).
- A change that drops a column or table and adds another makes drizzle-kit ask whether it is a
  rename; with no terminal it exits listing `missing_hints`. Do not answer it: split the change
  into expand and contract steps (step 5).
- drizzle-kit's own skills, vendored with this repo's commands: `drizzle-generate` (the JSON
  envelope with `--output json`, a dry run with `--explain`) and `drizzle-hints` (what a
  `missing_hints` asks). Where they differ from this skill, this skill wins: never answer a
  `rename_or_create` with a hint (step 5), never `drizzle-kit push`, never edit a tracked migration,
  and tests use `testDb()`.
- A data change (a backfill) is a migration of its own: `pnpm db:generate <what> --custom` writes
  an empty `migration.sql` for your SQL.
- So is a Postgres extension, which drizzle-kit does not manage: `pnpm db:generate enable_<ext>
--custom` with `CREATE EXTENSION IF NOT EXISTS <ext>;`, generated before the schema change that
  uses it. Every database that migrates then has it (`testDb()` clones the migrated database). The
  extensions Postgres ships (`pg_trgm`, `citext`, …) are in the `postgres` image the repo runs; any
  other (`pgvector`) needs an image that has it in `docker-compose.yml`, CI and production alike.
- Never edit a migration git tracks (staged or committed): the guard hook blocks it. To redo a
  new, untracked one you already applied: `pnpm db:reset` (wipes this checkout's whole local
  server: its dev, test and e2e databases; it refuses one other checkouts share), delete its
  folder, fix the schema and generate again, then `pnpm db:seed` (it migrates, then seeds).

## 3. Apply it

- `pnpm db:migrate` applies it to the dev database.
- Look at the rows: `pnpm db:psql -c "select count(*), count(author_name) from comments"` (its
  arguments reach psql as written, commas and `=` included: `docs/database.md`).

## 4. Seed and tests

- Change `packages/db/src/seed.ts` only when the feature needs seeded data, and then `SEED` in
  `apps/web-e2e/src/fixtures.ts` with it (e2e may not import `@acme/db`; specs assert on the seed).
- A constraint, index or default the schema enforces gets a test in
  `packages/db/src/schema.test.ts`. Tests that touch the database use `testDb()` from
  `@acme/db/testing`: each test file gets its own clone of the migrated template (rebuilt when
  `packages/db/migrations` changes), shared by its tests, so assert only on rows the test created.
- `pnpm nx run db:test` (it runs `db:db-check`, drizzle-kit's consistency check of the
  migrations, first), then the projects that use the table: `pnpm nx run core:test`,
  `pnpm nx run api:test`.

## 5. Deploys: expand, then contract

Every deploy runs the migrations first (`node dist/migrate.mjs` from the api image: Railway's
pre-deploy command, the `migrate` service of `docker-compose.stack.yml`) while the previous API
still serves requests; the new API starts after them (`docs/deployment.md`). So a migration must
work with the code before it and after it, and so must a rollback of the code. A backfill ships
one deploy after the code that writes the column: rows the previous API inserts while the
migrations run would miss it.

- **One deploy:** a new table; a nullable column, or one with a default; a new index (on a large
  table: below); a dropped `NOT NULL` or check.
- **A new index on a large table:** drizzle-kit writes a plain `CREATE INDEX`, which blocks writes
  to the table while it builds (harmless at this template's size). `CREATE INDEX CONCURRENTLY`
  does not, but cannot be a migration here: the migrator runs every pending migration in one
  transaction, where it fails. So a human builds it on production before the deploy, with
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS …` (a failed build leaves an invalid index: drop it,
  retry), and the new, untracked migration says `CREATE INDEX IF NOT EXISTS`: it skips the index
  there and builds it everywhere else.
- **A required column:** deploy 1 adds it nullable (or with a default) and the code writes it.
  Deploy 2 backfills the old rows in a custom migration, generated before the schema edit that
  makes it `NOT NULL` (migrations run in the order they were generated).
- **A rename:** deploy 1 adds the new column, nullable; the code writes both and still reads the
  old one. Deploy 2 copies the old values in a custom migration (then `NOT NULL` when the column
  is required, as above), and the code reads the new column and still writes both, so a rollback
  to deploy 1 reads complete rows. The old column then goes as a column drop (below): two more
  deploys. Never one rename.
- **A renamed column behind an API field:** rename the field in the same deploys (skill
  `graphql-change`, step 3). Deploy 1 adds the new field and input, and the new field still reads
  the old column: rows the previous API inserts while deploy 1's migrations run have only that
  one. Deploy 2, with the backfill, switches both fields to the new column, deprecates the old
  field and input, and moves the web to the new ones. Deploy 3 removes them, with the old column's
  schema entry; deploy 4 drops the column.
- **A column drop:** deploy 1 removes every use of it (an API field first: skill `graphql-change`
  deprecates it) and removes it from `packages/db/src/schema`: Drizzle names every schema column
  in each insert (`default` for a value left out) and in each select without a field list, so code
  that still has the column in its schema fails once it is gone. The generated migration drops it
  under the API that still uses it: before you apply it (it is new and untracked), replace its
  `DROP COLUMN`. A `NOT NULL` column without a default gets one (`ALTER COLUMN … SET DEFAULT …`,
  or `DROP NOT NULL` when no default fits), so inserts can leave it out; otherwise leave only a
  comment. Its snapshot already records the column as gone. Deploy 2 drops it in a custom
  migration (step 2): by then neither the serving code nor a rollback target has it in its schema.
- **A table drop:** deploy 1 removes every use of it (API fields first, as above; then its
  queries and relations) but keeps the table in `packages/db/src/schema`, so its migration has no
  `DROP TABLE`: the previous API still reads the table while deploy 1's migrations run, and a
  rollback needs it. Code that never queries a table does not fail once it is gone, so deploy 2
  removes it from the schema, and its generated `DROP TABLE` drops it.
- Each step is its own PR, merged and deployed before the next one. Write every later deploy's
  steps (its SQL, the code changes, what each rollback reads) in the PR description and the commit
  message: the plans folder is gitignored, and the follow-up PR, in another worktree, starts from
  them.

## 6. Prove it

- `pnpm regen`, then `git status`: the only generated change is your migration folder.
- `pnpm check`. It fails on a schema change without its migration: its drift gate generates one
  with a random name, which you delete before `pnpm db:generate <what>`.
- `pnpm nx e2e web-e2e` when the API or web changed with it (skill `verify`).
