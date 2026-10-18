---
name: verify
description: 'Use when you are about to say a change is done: the "Done means" list of AGENTS.md as steps. Gives pnpm check (affected or --all), the extra checks each kind of change needs, running the change, turning manual checks into tests, and how to report the evidence.'
---

# Verify a change

`AGENTS.md`'s "Done means", as steps. Never claim done without them. When a check fails, fix the
cause: never weaken a test or a rule to get green (no `.skip`, no lowered limit or timeout, no lint
disable, no `--no-verify`, no edited snapshot of a wrong value).

## 1. Regenerate

- `pnpm regen`, then `git status`. Generated files (`.agents/generated.json` lists them) changed
  only through their commands, and the ones that changed are part of the change.

## 2. pnpm check

- `pnpm check` runs every gate on the affected projects: agent config, Nx's agent config,
  generated-file drift, lint, eslint (module boundaries), typecheck, test, test-browser, build, Nx
  sync, lint of the files no project owns, formatting, pinned versions, Markdown links. Docker must
  run (database tests), and Chromium must be installed (`pnpm exec playwright install chromium`).
- `pnpm check --all` runs every project. Use it for a change to tooling or shared config, one
  outside any project, or one that touches many projects, and once before a PR.
- It ends with `✓ pnpm check passed` or `✗ pnpm check failed: <gates>`; each failure is printed
  above it. Lint warnings do not fail it: read the ones in the files you changed.
- Rerun one failing target: `pnpm nx run <project>:<target>` (`--skip-nx-cache` reruns a cached
  one).

## 3. The checks each change needs

| The change touches                                               | Also run                                       |
| ---------------------------------------------------------------- | ---------------------------------------------- |
| routes, UI, the BFF or the API                                   | `pnpm nx e2e web-e2e` (skill `e2e-test`)       |
| `apps/*/Dockerfile`, `.dockerignore`, `docker-compose.stack.yml` | `pnpm nx run web-e2e:e2e-stack`                |
| the database schema                                              | skill `db-migration`, step 6                   |
| the GraphQL schema                                               | skill `graphql-change`, step 5                 |
| Nx or its plugins                                                | skill `nx-upgrade`, step 4                     |
| skills, `AGENTS.md`, `.claude/settings.json`                     | `pnpm agents:check` (`pnpm check` runs it too) |

## 4. Run it

A change to runtime behaviour is done when you have run it and seen it work, not when its tests
pass: skill `run-web` (the dev servers, a query through the BFF, the production build, the images).

## 5. Turn what you checked by hand into a test

Every check you made by hand (a curl, a page, a query) becomes a test at the lowest layer that sees
it: a unit test, an API test through `yoga.fetch`, a browser test, an e2e spec. When it is cheap,
see the test fail without your change.

## 6. Report the evidence

For each check: the command, its exit code or summary line, and what you saw. For example:

- `pnpm check` exited 0: `✓ pnpm check passed`.
- `pnpm nx e2e web-e2e` exited 0: every spec passed.
- `curl -fsS "$WEB/api/health"` answered `{"status":"ok","version":"dev"}`.

Name what you did not run, and why. Never report a check you did not run or a result you did not
see.
