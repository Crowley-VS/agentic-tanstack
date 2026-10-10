---
name: drizzle
description: 'Load before reading or editing a Drizzle file (anything importing from `drizzle-orm/*`), touching `drizzle.config.ts`, running drizzle-kit or handling its output. Says how drizzle-kit runs in this repo: only through the db project''s Nx targets.'
metadata:
  revision: 12
---

<!-- Vendored from drizzle-kit@1.0.0-rc.4 (skills/drizzle/SKILL.md), MIT: .agents/vendor/drizzle-kit/. Changed for this repo by the rewrites in .agents/vendor.json. Do not edit this copy: change its rewrites, then run `node tools/vendor-skills.mjs update`. -->

# Drizzle

This repo vendors this skill, `drizzle-generate` and `drizzle-hints` with their commands rewritten (`.agents/vendor.json`). Where they and skill `db-migration` differ, `db-migration` wins: expand and contract instead of renames, never an edit to a migration git tracks, `testDb()` from `@acme/db/testing` in tests that touch the database.

## Staleness check

Skip it here. `pnpm agents:check` (part of `pnpm check`) fails when the installed drizzle-kit
ships other skills than these copies, and `node tools/vendor-skills.mjs update` refreshes them
from it. Never run `drizzle-kit skills`: it installs `skills@latest` through a download-latest
runner and writes unrewritten copies over these.

## Surface selection

drizzle-kit exposes its verbs (`generate`, `push`, `pull`, `up`, `check`, `export`) over a CLI,
an SDK and an MCP server; all three return the same JSON envelope and take the same `hints`
array. Here only the CLI runs, in `packages/db` (its `drizzle.config.ts`), through the db
project's Nx targets. No drizzle MCP server is configured.

- `pnpm nx run db:db-generate --args="--name=<what>"`: a new migration from the schema (skill
  `db-migration`). Add `--output json` inside `--args` for the envelope, and `--explain` for a dry
  run that writes nothing: `pnpm nx run db:db-generate --args="--output json --explain"`.
- `pnpm nx run db:db-check`: drizzle-kit's consistency check of `packages/db/migrations`
  (`pnpm nx run db:test` runs it first).
- `push`, `pull`, `up` and `export` are not used: every schema change is a generated, reviewed
  and committed migration, which each deploy applies.
- Never `npx drizzle-kit`, a global `drizzle-kit` or a download-latest runner (`pnpm dlx`): they
  run another version than the pinned one.
