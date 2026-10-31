# Testing

Every kind of test in the repository, where it lives and how to run it, and what `pnpm check` and
CI run. Each area's doc has its own testing details; this page is the map.

## The kinds of tests

| Kind                 | Files                                                                                                     | Projects                                        | Run one project                 | Needs            |
| -------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------- | ---------------- |
| Unit (Node)          | `src/**/*.test.ts(x)`; `tools/test/**/*.test.mjs`, `.railway/*.test.ts`, `apps/web/scripts/**/*.test.mjs` | validators, logger, ui, web, tools, railway-iac | `pnpm nx run <project>:test`    | nothing          |
| Database             | `src/**/*.test.ts` using `testDb()`                                                                       | db, core                                        | `pnpm nx run core:test`         | Docker           |
| API                  | `apps/api/src/**/*.test.ts` (`yoga.fetch`)                                                                | api                                             | `pnpm nx run api:test`          | Docker           |
| Built web server     | `apps/web/src/built-server.test.ts`                                                                       | web (`web:test` builds first)                   | `pnpm nx run web:test`          | nothing          |
| Browser (components) | `apps/web/src/**/*.browser.test.tsx`                                                                      | web                                             | `pnpm nx run web:test-browser`  | Chromium         |
| End to end           | `apps/web-e2e/src/*.spec.ts`                                                                              | web-e2e                                         | `pnpm nx e2e web-e2e`           | Docker, Chromium |
| End to end on images | the same specs, in BASE_URL mode                                                                          | web-e2e                                         | `pnpm nx run web-e2e:e2e-stack` | Docker, Chromium |

Chromium, for browser tests and e2e: `pnpm exec playwright install chromium`, once per machine and
after each Playwright bump. Docker must be running for every project tagged `needs-db` (api, core,
db): their tests start this checkout's Postgres themselves. Without Docker,
`pnpm nx affected -t test --exclude=tag:needs-db` runs the rest. Tests always run through Nx, never
`vitest` directly: Nx gives them the project graph, the cache and the right working directory.

One file or one test: `pnpm nx run <project>:test -- <file>` (Vitest's own arguments after `--`, so
`-t "<name>"` too); the same for `test-browser`, and `pnpm nx e2e web-e2e -- <spec> -g "<name>"`.
A cached result replays: `--skip-nx-cache` reruns it.

### Unit tests

Vitest in Node (each project's `vitest.config.ts`, `.mjs` in tools and scripts, inferred by
`@nx/vitest`; its `include` lists the project's test files). The tools project
(`tools/test`) tests the repository's own machinery: the hooks, `pnpm check`'s gates, the dev
ports, the agent-config checks, the permissions in `.claude/settings.json`, the CI workflow's
wiring. `scripts/test` tests bootstrap (template only: bootstrap removes the project).

### Database and API tests

Every test file that touches the database gets **its own database**: the project's Vitest config
spreads `dbTestConfig()`, and the file calls `testDb()` from `@acme/db/testing`, a fresh clone of a
migrated template database on this checkout's server. Tests in one file share it, so assume nothing
about rows other tests wrote ([database.md](database.md#test-databases)).

API tests call the Yoga app in process (`yoga.fetch`) on such a database. They pin each security
default (CSRF, armor limits, no introspection in production, the internal secret), count SQL
statements to catch N+1 queries (a page of notes with comments and counts is one statement), and
check that the schema prints with an empty environment and matches the committed
`schema.graphql`.

### Browser tests

Component tests in real Chromium, through Vitest Browser Mode (`vitest.browser.config.ts`,
headless; `HEADED=1` to watch). They mock `execute()`'s module, seed the app status in the
`QueryClient`, and load the app's stylesheet, so visibility and disabled states are real
([web.md](web.md#browser-tests)). `apps/web/src/test-projects.test.ts` checks that every test file
runs in exactly one of the two Vitest configs. Every run logs two Vite "Pre-transform error" lines
(`#tanstack-router-entry`, `tanstack-start-manifest:v`): they are expected (server code left out of
pre-bundling, `vitest.browser.config.ts`); judge the run by its "Tests … passed" line.

### End-to-end tests

Playwright drives Chromium against the **production builds** (web's `.output`, the API's `dist`)
on this checkout's e2e ports, with a freshly seeded e2e database: never the dev servers or the dev
database. Specs assert only on rows they created or on the seed, which they never change.
`web-e2e:e2e-stack` runs the same specs against the production images. The rules for writing
specs, BASE_URL mode, reports and traces: [e2e.md](e2e.md) and skill `e2e-test`.

## What `pnpm check` runs

`pnpm check` (`tools/check.mjs`) is the definition of done, for people, agents and CI alike. It runs
every gate on the affected projects (`--all`: every project) and reports every failure:

1. **agent config**: skills, subagents and settings are in sync and name only paths and scripts
   that exist (`pnpm agents:check`);
2. **Nx agent config**: `nx configure-ai-agents --check`;
3. **generated files**: `pnpm regen` would change no committed file;
4. **nx**: `lint`, `eslint`, `typecheck`, `test`, `test-browser` and `build` on the affected
   projects;
5. **nx sync**: the tsconfig project references are up to date;
6. **lint outside projects**: oxlint on the scripts no project owns;
7. **format**: every file oxfmt formats is formatted;
8. **versions**: Node and pnpm match across `.node-version`, `.prototools`,
   `package.json#packageManager` and the Dockerfiles;
9. **doc links**: every relative link and `#anchor` in the Markdown files resolves
   (`tools/doc-links.mjs`).

It does **not** run the e2e specs or the image checks: run `pnpm nx e2e web-e2e` after a route, UI
or API change, and `pnpm nx run web-e2e:e2e-stack` after a Dockerfile, `.dockerignore` or
`docker-compose.stack.yml` change (`AGENTS.md`, "Done means").

## What CI runs

`.github/workflows/ci.yml`, on every pull request and push to `main`, with no secrets (forks too):

- **`pnpm check`**: installs the pinned toolchain and Chromium, starts Postgres when a `needs-db`
  project is affected, runs `pnpm check` on the affected projects, then checks that the generators
  and builds replay from the Nx cache on a second run, then runs the e2e specs as one task per spec
  file, three at a time (`e2e-ci`). On a failure it uploads the test output (reports, traces,
  screenshots).
- **Docker images**: when web, api or what they use changed, builds the images, starts them
  together, checks them (production mode, non-root, the API refuses a caller without the secret,
  both servers report the commit, a clean exit within 10 s of SIGTERM) and runs every e2e spec
  against them ([deployment.md](deployment.md#ci-the-docker-job)).

The upstream template repository also runs a smoke test that bootstraps fresh copies (a tarball
and a "Use this template" copy) and runs `pnpm check --all` on them. It runs only where the
repository variable `TEMPLATE_MAINTENANCE` is `true`, and bootstrap removes it from projects.

## Writing tests

- Turn anything you checked by hand into a test, at the lowest layer that sees it: a unit test, an
  API test through `yoga.fetch`, a browser test, an e2e spec.
- When a check fails, fix the cause; never weaken the test, skip it, or raise a limit to get green.
- The Notes board has a test at every layer: copy those (skill `add-feature` lists them).
