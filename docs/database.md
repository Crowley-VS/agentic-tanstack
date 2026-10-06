# The database (`packages/db`)

Details behind the database lines of `AGENTS.md`: the commands, schema changes and the test
databases.

Postgres 18 runs in Docker, one server per checkout: each git worktree gets its own port and
databases (`pnpm ports`). Docker must be running. Targets that need the database start and migrate
it first (`db:db-migrate` depends on `db:db-up`, `db:db-seed` and `api:dev` on `db:db-migrate`).

| Task                                       | Command                                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Start it (fast no-op when it runs)         | `pnpm db:up`                                                                              |
| Migrate / reseed (deterministic data)      | `pnpm db:migrate` / `pnpm db:seed`                                                        |
| Change the schema                          | edit `packages/db/src/schema/*`, then `pnpm nx run db:db-generate --args="--name=<what>"` |
| Wipe it and start an empty server          | `pnpm db:reset` (then `pnpm db:seed` migrates and seeds it)                               |
| Browse data (the studio URL: `pnpm ports`) | `pnpm db:studio` · `pnpm nx run db:db-psql` (`-- -c "select …"` runs one query)           |
| Stop it, data kept / remove leftovers      | `pnpm teardown` / `pnpm prune:orphans` (`docs/local-resources.md`)                        |

`db-psql` and `db-studio` open the dev database, which exists only after `pnpm db:migrate` (or
`pnpm db:seed`) has run once in this checkout: `pnpm check` creates only test databases.

## Migrations

Generate them from the schema with a name (`pnpm regen` runs `db:db-generate` without one, so a
pending schema change would get a random name), read the SQL, and commit them. Once git tracks a
migration (staged or committed) the guard hook blocks edits to it; only a new, untracked one may
still be edited. A new field end to end, migration included: skill `add-feature`.

## Test databases

Tests that touch the database use `testDb()` from `@acme/db/testing` (their Vitest config spreads
`dbTestConfig()`): each test file gets its own database, a fresh clone of the migrated template,
and its tests share it. Assume nothing about rows other tests write. The e2e database is separate
again: `docs/e2e.md`.
