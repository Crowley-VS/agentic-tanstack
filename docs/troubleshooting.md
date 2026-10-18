# Troubleshooting

The failures people and agents hit most, what causes each, and the fix. Each links the doc that
explains the mechanism.

## Docker is not installed or not running

```text
[db-up] Docker is not running. Start it and retry.
[db-up] Docker is not installed (no `docker` on PATH). Install Docker Engine with Compose v2.
```

`pnpm dev`, `pnpm check` (the database tests), e2e and every `pnpm db:*` command start this
checkout's Postgres container, so they need Docker Engine with Compose v2, running. Start Docker
(Docker Desktop, or `sudo systemctl start docker` on Linux) and retry; `pnpm db:up` is a fast no-op
once the server answers. Without Docker you can still run every check but the database tests:
`pnpm nx affected -t lint eslint typecheck build` (no target but `test` needs a database), then
`pnpm nx affected -t test --exclude=tag:needs-db` (the tests of every project but api, core and
db).
More: [database.md](database.md).

## A port is taken

```text
[db-up] Port 5432 is taken by something else. Retry with DB_PORT=<free port>.
```

The primary checkout uses fixed ports (web 3000, API 4000, Postgres 5432, e2e 3100 and 4100, the
image stack 3200), and another program may hold one: a local Postgres on 5432 is the usual one.
`pnpm ports` prints this checkout's ports. Override one in your shell, never in `.env` (which holds
no ports):

```bash
DB_PORT=55432 pnpm db:up
WEB_PORT=3005 API_PORT=4005 pnpm dev
```

The variables are `WEB_PORT`, `API_PORT`, `DB_PORT`, `DB_STUDIO_PORT`, `WEB_E2E_PORT`,
`API_E2E_PORT` and `STACK_PORT` (`tools/dev-ports.mjs`). Export them in your shell profile to keep
them, since every command computes the ports again. Linked worktrees get a block of ports of their
own, so two worktrees never collide with each other.

## Containers, daemons and temp files pile up

Each checkout starts its own Postgres container and Nx daemon, and agents work in throwaway
worktrees. Before you delete a worktree, stop the servers you started in it and run
`pnpm teardown` there (it keeps the data). For worktrees already deleted, run `pnpm prune:orphans`
from any checkout of the repository: it removes their containers, volumes, images, Nx daemons and
temp files. Docker's build cache is shared and never pruned for you: `docker builder prune`.
More: [local-resources.md](local-resources.md).

## Docker Hub rate limits (`toomanyrequests`)

Pulling the Postgres image (`docker-compose.yml`) or the Node base image anonymously counts
against Docker Hub's per-IP pull limit, which shared CI runners and busy networks reach.
`pnpm db:up` tries `compose up` up to 4 times on a `toomanyrequests` (and on network errors): 3
retries, 2, 4 and 8 s apart; past that it fails.

- **Locally:** `docker login` raises the limit; or wait.
- **In CI** (your project's own workflow; the template's works without secrets): log in to
  Docker Hub before the step that first pulls an image, with a read-only access token stored as a
  repository secret. GitHub does not allow `secrets` in an `if`, so the job passes it through `env`:

  ```yaml
  jobs:
    check:
      env:
        DOCKERHUB_TOKEN: ${{ secrets.DOCKERHUB_TOKEN }}
      steps:
        # … checkout and setup, then before "Start Postgres":
        - uses: docker/login-action@v4
          if: env.DOCKERHUB_TOKEN != ''
          with:
            username: ${{ vars.DOCKERHUB_USERNAME }}
            password: ${{ env.DOCKERHUB_TOKEN }}
  ```

  The `if` skips the login where the secret is missing (forks, and pull requests from forks, which
  receive no secrets), so the workflow still runs there. The `docker` job pulls too: give it the
  same `env` and step, before it builds the images.

## Browser or e2e tests cannot find Chromium

```text
browserType.launch: Executable doesn't exist at …
```

Browser tests (`web:test-browser`), e2e and the agents' browser CLI need Playwright's Chromium,
installed once per machine and again after each Playwright bump:

```bash
pnpm exec playwright install chromium
```

An e2e result cached from before the install still replays: rerun with `--skip-nx-cache`. On a
Linux machine that lacks the browser's system libraries: `pnpm exec playwright install --with-deps
chromium` (it uses `sudo`). Watching a test needs the full browser, not the headless shell:
`HEADED=1 pnpm nx run web:test-browser --skip-nx-cache`. More: [e2e.md](e2e.md).

## Nx misbehaves: stale results, daemon errors

- **A result that cannot be right** (a pass after a change that should fail, a generated file that
  did not update): rerun the task with `--skip-nx-cache`. To clear the cache and stop the daemon:
  `pnpm nx reset`.
- **Daemon errors** (`Daemon process terminated`, an Nx database error such as
  `FOREIGN KEY constraint failed`): `pnpm nx daemon --stop` (or `pnpm nx reset`), then rerun; Nx
  starts a new daemon when it needs one. `NX_DAEMON=false` runs one command without it.
- **`pnpm dev` stops regenerating operations on save:** the watcher (`web:codegen-watch`) needs the
  daemon; with `NX_DAEMON=false` it exits, and you run `pnpm nx run web:codegen` yourself.
- **ESLint's boundary rule reports nothing:** run it through Nx (`pnpm nx run <project>:eslint`),
  never `eslint` directly; it needs Nx's project graph.
- **An e2e run uses old code:** a `serve-e2e` you started yourself is reused by Nx and keeps the
  code it started with. Stop it before the run ([e2e.md](e2e.md#what-a-run-does)).

## The `.env` file and `INTERNAL_API_SECRET`

```text
invalid API environment:
  INTERNAL_API_SECRET: INTERNAL_API_SECRET must be at least 32 characters
```

Nx loads the root `.env` into every task. Bootstrap writes it once, with a generated
`INTERNAL_API_SECRET`; a fresh clone of your project needs it created by hand:

```bash
test -f .env || cp .env.example .env
node -p "require('node:crypto').randomBytes(32).toString('hex')"   # paste it as INTERNAL_API_SECRET
```

The secret may be unset in development, but when set it must have 32 characters or more, in both
apps. In production both servers require it: the API refuses to start without it, and the web
server's `/api/health` answers 503. The two services must share the same value
([deployment.md](deployment.md#what-the-images-expect-at-runtime)). Never commit `.env`; agents
are denied reading it.

## Writes fail with "Too many writes"

The BFF rate-limits writes per client IP, in development too (default 10 a minute). For scripted
writes: `WRITE_RATE_LIMIT=off pnpm dev`. The e2e servers turn it off themselves
([web.md](web.md#the-bff-post-apigraphql)).

## Windows

Native Windows is not supported: package scripts and tests assume a POSIX shell, and some
permission rules are not safe under `cmd.exe` ([database.md](database.md)). Use **WSL2**, with the
checkout inside the WSL file system (not under `/mnt/c`) and Docker Desktop's WSL integration or
Docker Engine inside WSL.

## Still stuck

Run `pnpm check` and read the first failure above its summary line; each gate prints its own
error. For a bug in the template itself, open an issue in the template repository with what you
ran, what happened, and your Node, pnpm, Docker and OS versions.
