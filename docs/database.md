# The database (`packages/db`)

Details behind the database lines of `AGENTS.md`: the commands, schema changes and the test
databases.

Postgres 18 runs in Docker, one server per checkout: each git worktree gets its own port and
databases (`pnpm ports`). Docker must be running. Targets that need the database start and migrate
it first (`db:db-migrate` depends on `db:db-up`; `db:db-seed`, `db:db-studio` and `api:dev` on
`db:db-migrate`); `db:db-psql` only starts the server.

| Task                                       | Command                                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Start it (fast no-op when it runs)         | `pnpm db:up`                                                                              |
| Migrate / reseed (deterministic data)      | `pnpm db:migrate` / `pnpm db:seed`                                                        |
| Change the schema                          | edit `packages/db/src/schema/*`, then `pnpm nx run db:db-generate --args="--name=<what>"` |
| Wipe it and start an empty server          | `pnpm db:reset` (then `pnpm db:seed` migrates and seeds it)                               |
| Browse data (the studio URL: `pnpm ports`) | `pnpm db:studio` · `pnpm nx run db:db-psql` (`-- -c "select …"` runs one query)           |
| Stop it, data kept / remove leftovers      | `pnpm teardown` / `pnpm prune:orphans` (`docs/local-resources.md`)                        |

`db-psql` opens the dev database, which exists once something has migrated it in this checkout
(`pnpm db:migrate`, `pnpm db:seed`, `pnpm db:studio` or `pnpm dev`; `pnpm check` creates only test
databases).

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

Their global setup starts the server as `pnpm db:up` does (`packages/db/scripts/db-up.mjs`), and
Nx runs the tests of several such projects at once (`pnpm check`, `nx run-many`). So one process
starts it: the first takes a lock file, `db-up-<compose project>.lock` in `db-up-<uid>` (a
directory of the temp directory that only you can write to), and the others wait until its
server answers, saying what they wait for after 5 s. A lock whose process has exited is taken
over at once; none is waited on for more than 10 minutes. A `compose up` that fails on a network
or registry error (a timeout, Docker Hub's `toomanyrequests`, a reset connection) runs again, up
to 4 times in all, 2, 4 and 8 s apart; any other failure is reported at once. When the start
fails anyway, the processes that waited on its lock fail with its error, without tries of their
own; a later start tries again. What a failed or killed start leaves in `db-up-<uid>`, and what
removes it: `docs/local-resources.md`. CI starts the server in a step of its own before
`pnpm check`, when a project tagged `needs-db` is affected.
