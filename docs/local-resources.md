# Local resources (what a checkout leaves running)

Every checkout (the primary one and each git worktree) starts things of its own that outlive it
unless something stops them: agents work in throwaway worktrees, so on a busy machine these pile
up. Details behind `pnpm teardown` and `pnpm prune:orphans`.

| What                  | Per                  | Started by                                 | Released by                            |
| --------------------- | -------------------- | ------------------------------------------ | -------------------------------------- |
| Postgres container    | checkout             | `pnpm db:up`, db tests, `pnpm dev`, e2e    | `pnpm teardown` (keeps the data)       |
| its volume (the data) | checkout             | the first `pnpm db:up`                     | `pnpm db:reset`, `pnpm prune:orphans`  |
| Nx daemon             | checkout (workspace) | the first `pnpm nx …` command              | `pnpm teardown`, deleting the checkout |
| dev / e2e servers     | whoever started them | `pnpm dev`, `serve-e2e`, a background task | whoever started them                   |

## `pnpm teardown`: release what this checkout started

Stops this checkout's Nx daemon (`nx daemon --stop`) and its Postgres container
(`node packages/db/scripts/db-up.mjs down`). It keeps the volume, so a checkout's dev data
survives (`pnpm db:up` brings it back); `pnpm db:reset` is what deletes data. It is idempotent and
takes well under a second when nothing runs, Docker stopped or missing included.

Run it before you delete a worktree. Servers you started yourself (`pnpm dev`, a background
`serve-e2e`) are yours to stop first. The review loop's agents do both as their last step, before
they reset their worktree (`.claude/workflows/review-loop-run.js`).

## `pnpm prune:orphans`: remove what deleted checkouts left behind

(`pnpm prune` is pnpm's own command, hence the name.) It removes:

- **Nx daemons** of this user whose workspace directory no longer exists (`tools/nx-daemons.mjs`).
  Nx 23.2's daemon exits by itself within moments of its checkout's deletion (it checks every
  20 ms that its pid file and the lock file are unchanged); this catches one that does not
  (another Nx version, a stuck process). A daemon's workspace is its working directory; it gets
  SIGTERM, Nx's own clean shutdown. One for a directory that is gone can serve no one, whichever
  repository it was.
- **Temp Nx installs** of processes that have exited: the `<tmp>/tmp-<pid>-*` copies of
  `nx@latest` (~4k files each) that every Nx daemon started without `NX_USE_LOCAL=true` leaves
  behind when it exits, however it exits (see below). Only this user's, holding a package.json
  of Nx packages alone.
- **This repository's Docker resources** whose checkout directory no longer exists: containers
  (running or not), volumes and networks (`packages/db/scripts/orphans.mjs`). It prints each
  compose project it removed and the directory it belonged to.

`pnpm db:up` (and everything that starts the database through it) runs the Docker part on its own
whenever it has to start the server, since it calls Docker then anyway: a deleted worktree's
container may hold a port that the port registry has since handed to a new worktree. When the
server already runs, `db:up` makes no Docker call at all.

### How it knows what is this repository's

`docker-compose.yml` labels the container and the volume with the repository's git common dir
(the `.git` directory all its worktrees share, so another clone of the same repository is another
repository) and the checkout's directory; `db-up` fills them in. Docker's own label filter lists
only this repository's labeled containers and volumes, and only the compose projects among them
whose checkout directory is gone are looked at further. Such a project is removed when every
resource of it labeled with this repository's common dir names a checkout directory that is gone,
and no container of it runs from a directory that still exists. Its containers, volumes and
networks then go, unlabeled ones of the same project included.

Never touched: other repositories' resources (another common dir, or no labels), anything of a
checkout whose directory exists, and projects without the labels: those made by a bare
`docker compose up` (no `db-up` to fill the labels in) or before the labels existed. A volume made
before them keeps its data and stays unlabeled (Docker volumes cannot be relabeled; compose's
"Recreate (data will be lost)?" defaults to no, and `db-up` runs compose without a terminal). To
clear such leftovers once, by hand:

```bash
docker ps -a --filter label=com.docker.compose.project --format '{{.Names}}\t{{.Label "com.docker.compose.project.working_dir"}}'
docker volume ls --filter label=com.docker.compose.project
docker compose -p <project of a deleted worktree> down -v   # or docker rm -f / docker volume rm
```

## Agent sessions: no temp files per checkout

`.claude/settings.json` sets two variables for every Claude Code session (and so for every
process it starts):

- `NX_USE_LOCAL=true`: without it, each Nx daemon installs `nx@latest` into a fresh
  `<tmp>/tmp-<pid>-*` directory (~4k files) for its "AI agent configuration outdated" and Nx
  Console checks, the first time a command asks. Its cleanup on shutdown is asynchronous and the
  daemon exits before it finishes (Nx 23.2, `nx daemon --stop` included), so every daemon leaves
  its copy: one per worktree, more with restarts. With it, Nx uses the installed version. (It also
  makes `nx migrate` run the installed Nx instead of fetching the latest.)
- `NODE_DISABLE_COMPILE_CACHE=1`: ESLint's and Vite's command-line entry points (and others) turn
  on Node's compile cache, by default in `<tmp>/node-compile-cache`. Node keys it by file path, so
  every worktree adds its own few thousand files there, and nothing ever removes them (200k files
  on a 1M-inode `/tmp`).

Startup measured on this repository (median of 8 to 10 runs; Node 24):

| Command                                                | cache in /tmp, warm | cold (a new worktree) | off    | relocated, warm |
| ------------------------------------------------------ | ------------------- | --------------------- | ------ | --------------- |
| ESLint on one file (Nx, TS and GraphQL plugins loaded) | 354 ms              | 592 ms                | 500 ms | 352 ms          |
| Vite resolving the web app's config and plugins        | 276 ms              | 427 ms                | 374 ms | 275 ms          |

Off costs 0.1 to 0.15 s per ESLint or Vite start against a warm cache, and saves as much on a
worktree's first run, when the cache is cold and Node has to write it; a throwaway worktree barely
gets past that. Relocating the cache (a relative `NODE_COMPILE_CACHE`, since settings values are
static strings) was as fast as `/tmp` but was rejected: the variable turns the cache on for every
Node process and each writes it under the directory it starts in (`node_modules/.cache/…` in temp
test repositories, packages without `node_modules`, anywhere).

Outside Claude Code (a terminal, CI) nothing sets them: export them in your shell if you run many
worktrees by hand, or run `pnpm prune:orphans` now and then. Nothing here removes an existing
`<tmp>/node-compile-cache`: it holds no process's state, so `rm -rf` it whenever it has grown.
