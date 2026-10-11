---
name: e2e-test
description: 'Use when writing or debugging a Playwright end-to-end spec in apps/web-e2e. Gives the fixtures and seed data a spec may rely on, how to run every spec, one file or one test, the per-file run CI does, traces and reports, and BASE_URL mode against the production images.'
---

# Write or debug an e2e spec

Read `docs/e2e.md` first. The specs drive Chromium against the production builds of web and api,
on this checkout's e2e ports and its own e2e database, dropped and seeded at the start of each run.

## 1. Write the spec

- A spec is `apps/web-e2e/src/<feature>.spec.ts`; `notes.spec.ts` and `board.spec.ts` are the
  reference. Import `test`, `expect` and the helpers from `./fixtures`
  (`apps/web-e2e/src/fixtures.ts`), never from `@playwright/test`.
- Each test makes its own rows: `uniqueTitle('<label>')` and the `createNote` fixture, which
  writes through the BFF (`gql()`) as the browser does. Never write through the API's port.
- Workers, per-file tasks and retries share one database: assert only on rows the test created,
  or on the seed through `SEED` in `fixtures.ts` (its count, titles and comment counts), never on
  a copy of its values. Never change or comment on a seed note: other specs assert on their exact
  titles and counts.
- The board is newest first, so other tests' notes come before yours: `showOnBoard()` pages
  through it until a note shows.
- A test that reads the seed skips without it (`test.skip(!seeded, NEEDS_SEED)`), and one that
  calls the API directly skips without `apiURL`: both can be missing in BASE_URL mode (step 4).
- Find elements by role and label, `exact: true`
  (`getByRole('textbox', { name: 'Comment', exact: true })`). Buttons that need JavaScript stay
  disabled until hydration and Playwright waits for them: no retries, no sleeps. `toPass()` is for
  loops only.
- A new seed row: change `packages/db/src/seed.ts` and `SEED` in `fixtures.ts` together (`type:e2e`
  may not import `@acme/db`).
- Keep the two `webServer` entries of `apps/web-e2e/playwright.config.mts` as they are:
  `tools/test/e2e-wiring.test.mjs` fails otherwise.

## 2. Run it

- `pnpm nx e2e web-e2e`: every spec in one Playwright run. Nx builds web and api, seeds the e2e
  database, starts both servers and stops them after. Cached: add `--skip-nx-cache` to rerun.
- Arguments after `--` go to Playwright. One file, one test:
  `pnpm nx e2e web-e2e -- src/harness.spec.ts -g "web health check"`. Watch it:
  `pnpm nx e2e web-e2e -- --headed`.
- As CI runs it, one Nx task per spec file:
  `NX_SKIP_ATOMIZER_VALIDATION=true pnpm nx run web-e2e:e2e-ci --parallel=3`. Without the
  variable Nx asks for Nx Cloud (`docs/e2e.md`).
- One e2e run per checkout at a time (each run drops the e2e database), and stop any `serve-e2e`
  you started yourself first: Nx would reuse that old server.
- Chromium once per machine and after each Playwright bump:
  `pnpm exec playwright install chromium`. The cache does not know the installed browser: rerun
  with `--skip-nx-cache` after an install.
- The e2e web server has no write rate limit (`E2E=1`): a spec never waits for one.

## 3. Debug a failure

- The HTML report is in `apps/web-e2e/test-output/playwright/report/`, and each failed test's
  `trace.zip`, screenshot and error context in `apps/web-e2e/test-output/playwright/output/`
  (gitignored; a per-file run puts each file's under a folder of its own).
- Open them: `pnpm exec playwright show-trace <trace.zip>` and
  `pnpm exec playwright show-report <report dir>`. The report never opens by itself.
- On CI: the `test-output` artifact (the `docker` job's is `docker-test-output`);
  `pnpm nx run web-e2e:e2e-ci--merge-reports` merges the per-file reports.
- To poke at the servers: `pnpm nx run-many -t serve-e2e -p api web` in the background, with the
  e2e URLs from `pnpm ports`. Stop it before the next e2e run.

## 4. Against the production images

- After a change to a Dockerfile, `.dockerignore` or `docker-compose.stack.yml`:
  `pnpm nx run web-e2e:e2e-stack`. It builds and starts the images, seeds their database, runs
  every spec in BASE_URL mode with `E2E_SEEDED=1`, and removes the stack (`docs/deployment.md`).
  Arguments after `--` go to Playwright.
- BASE_URL mode by hand, against a stack already up:
  `BASE_URL=<web origin> E2E_SEEDED=1 pnpm nx run web-e2e:e2e-base-url`. Set `E2E_SEEDED=1` only
  when its database holds the seed, and `API_URL` only when its private API is reachable from here.
  The specs write dozens of notes: point it only at a stack you can throw away, with `READ_ONLY`
  off and no write rate limit (else 429s). The local images take theirs from
  `STACK_WRITE_RATE_LIMIT`: start, seed and test them as the block in `docs/deployment.md` does
  (`STACK_WRITE_RATE_LIMIT=off pnpm nx run web-e2e:stack-up`); any other stack needs
  `WRITE_RATE_LIMIT=off` on its web server.
- `e2e` and `e2e-ci` refuse to run while `BASE_URL` is set.

## 5. Prove it

- The spec passes in `pnpm nx e2e web-e2e` and in the per-file run, where it shares the database
  with the other files.
- `pnpm check` typechecks and lints `apps/web-e2e`.
