# End-to-end tests (`apps/web-e2e`)

Details behind the e2e line of `AGENTS.md`: what `pnpm nx e2e web-e2e` runs, the rules the specs
follow, and where the reports go.

## What a run does

Playwright drives Chromium (headless) against the **production builds**: web's `.output` and api's
`dist`, on this checkout's e2e ports (`pnpm ports`: "e2e web", "e2e api"), never the dev servers or
the dev database. It needs Docker, like the database tests, and Chromium, like the browser tests
(`pnpm exec playwright install chromium`, once per machine and after each Playwright bump). Nx
runs, in order:

1. `api:build`, `web:build` (cached), and `db:db-seed-e2e`: this checkout's e2e database (`e2e`,
   or `e2e_<hash>` in a worktree; `E2E_DATABASE_URL` overrides it, `DATABASE_URL` never does)
   dropped, recreated, migrated and seeded. It refuses a database that is not on this machine;
2. `api:serve-e2e` and `web:serve-e2e`, continuous: `NODE_ENV=production` with a fixed test
   `INTERNAL_API_SECRET` (not a secret: it only ever guards the e2e servers), both on 127.0.0.1;
   web adds `E2E=1` (no write rate limit), api pins `READ_ONLY=false`. These values live in the
   targets (`pnpm nx show project api --json`) and win over the shell and `.env`;
3. `web-e2e:e2e--wait-for-webserver`, until both health URLs answer;
4. the specs; then Nx stops the servers.

It works while `pnpm dev` runs (other ports, other database). **Stop any `serve-e2e` you started
yourself before an e2e run.** Nx reuses a `serve-e2e` task that another Nx process runs instead of
starting its own, and that server keeps the code it started with: after a web rebuild its pages
ask for scripts the build deleted (nothing hydrates, the specs fail); after an api rebuild the
specs pass against the old API, and Nx caches that pass for the new code.

**One e2e run per checkout at a time.** Each run's `db:db-seed-e2e` drops the e2e database, so a
second run (another terminal or agent in the same checkout) deletes it under the first run's
servers and specs, which then fail or flake. Run e2e in parallel only from separate worktrees: each
has its own ports and database.

| Task                                     | Command                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| Every spec, one Playwright run           | `pnpm nx e2e web-e2e` (cached: `--skip-nx-cache` reruns)                      |
| One task per spec file, 3 at a time (CI) | `NX_SKIP_ATOMIZER_VALIDATION=true pnpm nx run web-e2e:e2e-ci --parallel=3`    |
| One spec or test                         | `pnpm nx e2e web-e2e -- src/harness.spec.ts -g "health"`                      |
| The servers alone (to poke at them)      | `pnpm nx run-many -t serve-e2e -p api web` in the background; stop before e2e |
| Watch it in a browser                    | `pnpm nx e2e web-e2e -- --headed`                                             |
| Against the production images            | `pnpm nx run web-e2e:e2e-stack` (`docs/deployment.md`)                        |
| Against a stack already running          | `BASE_URL=<web origin> pnpm nx run web-e2e:e2e-base-url` (below)              |

The result is cached on the specs, web, api and what they use, and on `dbServer`
(`docker-compose.yml` and `tools/dev-ports.mjs`: how ports are chosen, not their values), but not
on the installed Chromium: rerun with `--skip-nx-cache` after a browser install.

Nx refuses the per-spec `e2e-ci--*` tasks without Nx Cloud unless `NX_SKIP_ATOMIZER_VALIDATION=true`
is set; they run fine on one machine, sharing one api and one web server. That variable is an
internal Nx escape hatch, not a documented option: if an Nx upgrade removes it, use
`pnpm nx affected -t e2e` (one Playwright run for every spec) locally and in CI instead.

## Against a running stack: BASE_URL mode

`BASE_URL=<web origin> pnpm nx run web-e2e:e2e-base-url` runs every spec, in one Playwright run,
against a stack that is already up: the production images (`web-e2e:e2e-stack` and CI's `docker`
job start them and run this, `docs/deployment.md`), or a deploy. It builds, seeds and starts
nothing, and is never cached (the stack can change without a commit). Two more variables say what
that stack offers; a spec that needs what is missing skips, saying why:

| Variable       | Set it when                                                      | Without it, skips                                   |
| -------------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| `API_URL`      | the API's own address is reachable from here (it is private)     | the API's 401 check (`harness.spec.ts`)             |
| `E2E_SEEDED=1` | its database holds the seed (`db:db-seed`, local databases only) | `seed.spec.ts` and the 3 seed tests of `board.spec` |

`E2E_REQUIRE_STACK=1` (set by `e2e-stack` and CI) refuses to run without `E2E_SEEDED=1`, so a
mistyped variable fails the run instead of skipping the seed's specs. The images' stack publishes
no API port, as a platform does: there the 401 spec skips, and CI's `docker` job checks the 401
from inside the stack's network instead.

The specs write (dozens of notes per run, and they stay): point BASE_URL only at a stack you can
throw away, with `READ_ONLY` off and `WRITE_RATE_LIMIT=off` on the web server (else 429s).

BASE_URL is for `e2e-base-url` only, which in turn refuses to run without it (Playwright would
start the e2e servers itself, outside Nx). `e2e` and `e2e-ci` start their own servers: with
BASE_URL set they fail at once (nx.json hashes it, so no cached result is replayed instead).

## Writing specs

- Specs are `src/*.spec.ts`; import `test` and `expect` from `./fixtures`, never from
  `@playwright/test` directly. Specs see the apps as a browser does: `type:e2e` may import shared
  utilities (`type:util`) only, so the seed's shape is copied into `SEED`.
- Workers, parallel `e2e-ci` tasks and retries share one database: assert only on rows the test
  created (`uniqueTitle()`, the `createNote` fixture), or on the seed (`SEED`). The notes list is
  newest first, so other tests' notes come before the seed.
- **Seed rows are read-only.** No spec comments on a seed note or changes one: other specs assert
  on their exact titles and comment counts. Work on a note the test created instead.
- Prefer roles and labels (`getByRole`, `getByLabel`) to CSS selectors. `getByLabel` matches
  any accessible name containing the text: on a note's page `getByLabel('Comment')` finds the
  comments section, the comment form and its field, so name a field by its role
  (`getByRole('textbox', { name: 'Comment', exact: true })`).
- Buttons that need JavaScript (Load more, a form's submit) render disabled until hydration
  (`docs/web.md`), and Playwright waits for them to be enabled: no hydration retries. `toPass()`
  is only for loops, such as `showOnBoard()` in `fixtures.ts`, which pages through the board
  until a note shows: use it rather than a loop of your own.
- Data setup goes through the BFF (`gql()`), as the browser does: never through the API port.
- A test that reads the seed skips without it (`test.skip(!seeded, NEEDS_SEED)`; a whole file or
  group: `test.skip(({ seeded }) => !seeded, NEEDS_SEED)`), and one that calls the API directly
  skips without `apiURL`: both can be missing in BASE_URL mode.
- Keep the two `webServer` entries in `playwright.config.mts` exactly as they are: a command that
  is not `pnpm nx run <project>:<target>`, an `env` or `wait` key, or `reuseExistingServer: false`
  makes `@nx/playwright` infer no server dependency, and Nx then runs `e2e-ci` tasks one at a time
  (`tools/test/e2e-wiring.test.mjs` fails).

## The e2e database is dropped WITH (FORCE)

The test databases are dropped with a plain `DROP DATABASE` (`packages/db/src/testing/setup-file.ts`):
`WITH (FORCE)` would kill a connection that is still closing, which surfaces as an unhandled
`57P01` error. `db:db-seed-e2e` deliberately does the opposite, for the e2e database only: a
leftover e2e server (a crashed run, or one another Nx process still runs) holds connections to it,
and a plain DROP would wait on them forever. FORCE terminates them; the API's pool absorbs the
`57P01`. Nothing else uses `ensureDatabase(url, { fresh: true })` but its own test.

## Reports and traces

Under `apps/web-e2e/test-output/playwright/` (gitignored): `report/` (HTML), `output/` (each failed
attempt's `trace.zip`, screenshot and error context), and on CI `blob-report/`, which
`pnpm nx run web-e2e:e2e-ci--merge-reports` merges into one HTML report. CI uploads the folder
when a step fails (artifact `test-output`; the `docker` job's single run, with its own `report/`:
`docker-test-output`). The HTML report never opens by itself (its server would keep a failed task
running): open it with `pnpm exec playwright show-report <dir>`, a trace with
`pnpm exec playwright show-trace <trace.zip>`.

## Driving the app by hand (agents)

`pnpm exec playwright cli` (Playwright's agent CLI, headless by default; skill `playwright-cli`)
opens a page and prints its accessibility snapshot with element refs to act on, as skill
`run-web` does:

```bash
pnpm exec playwright cli open --browser=chromium
pnpm exec playwright cli goto http://localhost:<port>   # the URL from `pnpm ports`
pnpm exec playwright cli snapshot
pnpm exec playwright cli click e8
pnpm exec playwright cli close-all
```

`goto` takes the URL as `pnpm ports` prints it: "e2e web" for the e2e servers, "web" for
`pnpm dev`. Against `pnpm dev` the first snapshot can come before hydration: every button that
needs JavaScript shows `[disabled]` (`docs/web.md`), so snapshot again once one is enabled. Its
files go to `.playwright-cli/` (gitignored).
