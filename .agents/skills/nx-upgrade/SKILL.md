---
name: nx-upgrade
description: 'Use when upgrading Nx and its @nx/* plugins: a new Nx release, or a bot PR that bumps them. Gives nx migrate with the pnpm catalog, running and removing the migrations, and every check an upgrade can break: regen, pnpm check --all, both e2e runs and the agent config.'
---

# Upgrade Nx

<!-- agents:unchecked migrations.json -->

`nx` and every `@nx/*` plugin move together, through `nx migrate`, which also runs the code
migrations a release ships. A bot PR (Renovate, Dependabot) that only bumps their versions skips
those migrations: close it and follow this skill.

## 1. Plan

- Read the release notes from the installed version (`pnpm nx --version`) to the target. Cross one
  major at a time: `nx migrate` offers the steps (`--multiMajorMode=gradual`).
- The upgrade is a PR of its own, with nothing else in it.

## 2. Update the versions

- `pnpm nx migrate latest`, or `pnpm nx migrate <version>`. Nx writes the new versions into the
  catalog of `pnpm-workspace.yaml` (`nx` and each `@nx/*` entry), and `migrations.json` at the
  root when the release ships migrations.
- Review `git diff package.json pnpm-workspace.yaml`. Versions live in the catalog: a version nx
  migrate wrote into a `package.json` moves there, and the `package.json` keeps `catalog:`. `nx`
  and every `@nx/*` keep one version (`pnpm check`'s versions gate fails otherwise). Read each
  entry of `migrations.json`.
- `pnpm install`. pnpm refuses a version published less than a day ago (`minimumReleaseAge` in
  `pnpm-workspace.yaml`): wait, never lower it.

## 3. Run the migrations

- `pnpm nx migrate --run-migrations --if-exists` applies `migrations.json` (a no-op without one),
  then read `git diff`: migrations rewrite `nx.json`, project config and source.
- `pnpm install` again if a migration changed dependencies.
- Delete `migrations.json`: it is not committed.

## 4. Check everything an upgrade can break

1. `pnpm regen`, then `git status`: changed codegen, route-tree or schema output is part of the PR.
2. `pnpm check --all`: every project, since plugin inference may change any target. It runs the
   tools tests that pin how Nx infers the e2e targets (`tools/test/e2e-wiring.test.mjs`) and the
   targets `.claude/settings.json` allows.
3. `pnpm nx e2e web-e2e`.
4. `NX_SKIP_ATOMIZER_VALIDATION=true pnpm nx run web-e2e:e2e-ci --parallel=3`: CI's per-file
   run. Nx refuses these atomized tasks without Nx Cloud unless NX_SKIP_ATOMIZER_VALIDATION is
   set, an internal escape hatch: if an Nx upgrade drops it, run `pnpm nx affected -t e2e` in the
   "End-to-end tests" step of `.github/workflows/ci.yml` instead (`docs/e2e.md`), and update this
   skill and `docs/e2e.md`.
5. `pnpm agents:nx-check`: the CLAUDE.md block, settings and `.gitignore` lines Nx writes for
   agents. On drift a human runs `pnpm agents:nx` and commits the result; agents never run
   `nx configure-ai-agents`.

## 5. Finish

- Commit `pnpm-workspace.yaml`, `pnpm-lock.yaml` and what the migrations changed, without
  `migrations.json`. The PR description lists the migrations that ran.
- On the PR, CI's "Generators and builds replay from the cache" step fails when the new Nx makes a
  task write its own inputs: fix that before merging.
