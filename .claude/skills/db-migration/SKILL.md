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

- `pnpm nx run db:db-generate --args="--name=<what>"` writes
  `packages/db/migrations/<timestamp>_<what>/migration.sql` and its `snapshot.json`. Always pass a
  name: `pnpm regen` runs the generator without one, so a pending change gets a random name.
- Read the SQL. Except in the contract step of an expand/contract change, it only adds (tables,
  nullable or defaulted columns, indexes) or relaxes (a dropped `NOT NULL` or check); a drop's
  first deploy replaces its generated `DROP COLUMN` (step 5).
- A change that drops a column or table and adds another makes drizzle-kit ask whether it is a
  rename; with no terminal it exits listing `missing_hints`. Do not answer it: split the change
  into expand and contract steps (step 5).
- A data change (a backfill) is a migration of its own:
  `pnpm nx run db:db-generate --args="--custom --name=<what>"` writes an empty `migration.sql` for
  your SQL.
- Never edit a migration git tracks (staged or committed): the guard hook blocks it. To redo a
  new, untracked one you already applied: `pnpm db:reset` (wipes this checkout's dev data), delete
  its folder, fix the schema and generate again, then `pnpm db:seed` (it migrates, then seeds).

## 3. Apply it

- `pnpm db:migrate` applies it to the dev database.
- Look at the rows: `pnpm nx run db:db-psql -- -c "select count(*) from notes"`. Nx splits a
  forwarded argument that holds `=`: pass such a query as
  `pnpm nx run db:db-psql --args='-c "select … where x = 1"'`.

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

- **One deploy:** a new table; a nullable column, or one with a default; a new index; a dropped
  `NOT NULL` or check.
- **A required column:** deploy 1 adds it nullable (or with a default) and the code writes it.
  Deploy 2 backfills the old rows in a custom migration, generated before the schema edit that
  makes it `NOT NULL` (migrations run in the order they were generated).
- **A rename:** deploy 1 adds the new column, nullable; the code writes both and still reads the
  old one. Deploy 2 copies the old values in a custom migration (then `NOT NULL`, as above), and
  the code reads the new column and still writes both, so a rollback to deploy 1 reads complete
  rows. The old column then goes as a drop (below): two more deploys. Never one rename.
- **A drop:** deploy 1 removes every use of it (an API field first: skill `graphql-change`
  deprecates it) and removes it from `packages/db/src/schema`: Drizzle names every schema column
  in each insert (`default` for a value left out) and in each select without a field list, so code
  that still has the column in its schema fails once it is gone. The generated migration drops it
  under the API that still uses it: before you apply it (it is new and untracked), replace its
  `DROP COLUMN`. A `NOT NULL` column without a default gets one (`ALTER COLUMN … SET DEFAULT …`,
  or `DROP NOT NULL` when no default fits), so inserts can leave it out; otherwise leave only a
  comment. Its snapshot already records the column as gone. Deploy 2 drops it in a custom
  migration (step 2): by then neither the serving code nor a rollback target has it in its schema.
- Each step is its own PR, merged and deployed before the next one.

## 6. Prove it

- `pnpm regen`, then `git status`: the only generated change is your migration folder.
- `pnpm check`. It fails on a schema change without its migration: its drift gate generates one
  with a random name, which you delete before generating with `--name`.
- `pnpm nx e2e web-e2e` when the API or web changed with it (skill `verify`).
