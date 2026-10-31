# 0009 — Vitest for unit and browser tests, Playwright for e2e and for agents' browser

- **Status:** accepted (2026-09-29)
- **Applies to:** every `test` and `test-browser` target, `apps/web-e2e`, the `playwright-cli` skill

## Context

Tests are how an agent proves a change, so they must be fast, run through Nx's cache, and test the
real thing: real Postgres for data code, a real browser for components, the production builds for
end-to-end flows. Agents also need to look at a running page themselves without spending a large
share of their context on it.

## Decision

- **Vitest 4** (4.1.11, pinned exactly with its browser provider) for every unit, API and database
  test, through `@nx/vitest`'s inferred `test` targets. Database tests get a database per test file
  (`testDb()`, [0007](0007-drizzle-docker-postgres.md)); API tests call Yoga through `yoga.fetch`.
- **Vitest Browser Mode** for components (`*.browser.test.tsx`, `web:test-browser`): real Chromium
  through `@vitest/browser-playwright`, headless unless `HEADED=1`, with the app's stylesheet loaded.
- **Playwright 1.63** (pinned exactly, one `playwright-core`, so one browser revision) for the e2e
  specs in `apps/web-e2e`, through `@nx/playwright`: against the production builds on this
  checkout's e2e ports and a freshly seeded e2e database, one task per spec file in CI (`e2e-ci`),
  and in BASE_URL mode against the production images (`e2e-stack`).
- **Agents drive a browser with Playwright's CLI** (`pnpm exec playwright cli`: open, snapshot,
  click, console), through the vendored `playwright-cli` skill with its commands rewritten to the
  pinned version. Playwright's test agents (planner, generator, healer) are an opt-in
  (`pnpm pw:agents`).

## Consequences

- One browser install serves browser tests, e2e and the agents' CLI:
  `pnpm exec playwright install chromium`, once per machine and after each Playwright bump.
- The e2e result is cached on the specs and the apps but not on the installed browser: rerun with
  `--skip-nx-cache` after a browser install ([e2e.md](../e2e.md)).
- `web:test` builds the web app first: it runs the production server as a process.
- The CLI's snapshots are compact accessibility trees saved to `.playwright-cli/`, so a look at a
  page costs far fewer tokens than an MCP server streaming its tool output.

## Alternatives considered

- **Jest**: slower, and not Vite-native (transforms configured twice).
- **jsdom or happy-dom for components**: fast but not a browser: layout, focus, `toBeVisible()` and
  disabled styles are approximations.
- **Cypress**: its own runner and browser setup, and parallel runs across machines go through its
  cloud service; Playwright runs specs in parallel workers locally and shares its browser install
  with Vitest's provider.
- **Playwright MCP** for agents: works, at a higher token cost per step than the CLI.
