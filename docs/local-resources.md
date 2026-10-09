# Local resources (what a checkout leaves running)

Every checkout (the primary one and each git worktree) starts things of its own that outlive it
unless something stops them: agents work in throwaway worktrees, so on a busy machine these pile
up. Details behind `pnpm teardown` and `pnpm prune:orphans`.

| What                                                     | Per                  | Started by                                    | Released by                                       |
| -------------------------------------------------------- | -------------------- | --------------------------------------------- | ------------------------------------------------- |
| Postgres container                                       | checkout             | `pnpm db:up`, db tests, `pnpm dev`, e2e       | `pnpm teardown` (keeps the data)                  |
| its volume (the data)                                    | checkout             | the first `pnpm db:up`                        | `pnpm db:reset`, `pnpm prune:orphans`             |
| Nx daemon                                                | checkout (workspace) | the first `pnpm nx …` command                 | `pnpm teardown`, deleting the checkout            |
| dev / e2e servers                                        | whoever started them | `pnpm dev`, `serve-e2e`, a background task    | whoever started them                              |
| production-image stack (containers, network, its images) | checkout             | `web-e2e:stack-up`, `docker-build`            | `web-e2e:stack-down`, `teardown`, `prune:orphans` |
| Docker's build cache                                     | machine (shared)     | every image build, of any checkout or project | `docker builder prune`, by hand (below)           |

## `pnpm teardown`: release what this checkout started

Removes this checkout's production-image stack (`node tools/stack-down.mjs`, what
`web-e2e:stack-down` runs: its containers, network and images, `docs/deployment.md`), then stops
its Nx daemon (`nx daemon --stop`) and its Postgres container
(`node packages/db/scripts/db-up.mjs down`). The stack goes first, without Nx (no project graph to
compute, no daemon to start), and the rest runs even when that fails. It keeps the Postgres volume,
so a checkout's dev data survives (`pnpm db:up` brings it back); `pnpm db:reset` is what deletes
data. It is idempotent and takes well under a second when nothing runs, Docker stopped or missing
included; about 2 s with a stack to remove.

Run it before you delete a worktree. Servers you started yourself (`pnpm dev`, a background
`serve-e2e`) are yours to stop first. The review loop's agents do both as their last step, before
they reset their worktree (`.claude/workflows/review-loop-run.js`). Skip it while a server you did
not start still runs in the checkout (the user's `pnpm dev`; the API's `/health` from `pnpm ports`
answers): its API answers every query with an error until `pnpm db:up` brings the database back.
A project `COMPOSE_PROJECT_NAME` (or, for the stack, `STACK_PROJECT`) names other than the
checkout's own may serve other checkouts too, so `teardown` leaves it running.

## `pnpm prune:orphans`: remove what deleted checkouts left behind

(`pnpm prune` is pnpm's own command, hence the name.) It removes the following, each part even when
another fails (the command then exits non-zero):

- **Nx daemons** of this user whose workspace directory was deleted (`tools/nx-daemons.mjs`).
  Nx 23.2's daemon exits by itself within moments of its checkout's deletion (it checks every
  20 ms that its pid file and the lock file are unchanged); this catches one that does not
  (another Nx version, a stuck process). A daemon's workspace is its working directory; it gets
  SIGTERM, Nx's own clean shutdown, then SIGKILL if it still runs 5 s later. One for a deleted
  directory can serve no one, whichever repository it was. On Linux "deleted" is the kernel's own
  mark on the directory, and only for a daemon in this machine's mount namespace: a daemon in a
  container (a devcontainer's, often the same uid) has paths that do not exist on the host and is
  alive, so it is never a candidate. A daemon that refuses the signals (a sandbox or security
  module's denial) or outlives them is reported, and the command exits non-zero.
- **Temp Nx installs** of processes that have exited: the `<tmp>/tmp-<pid>-*` copies of
  `nx@latest` (~4k files each) that every Nx daemon started without `NX_USE_LOCAL=true` leaves
  behind when it exits, however it exits (see below). Only this user's, holding a package.json
  of Nx packages alone. And Nx's temp npm directories with nothing installed in them, named the
  same way, of exited processes: package.json `{}` and Nx's copy of `pnpm-workspace.yaml` (and of
  `.npmrc`, if the workspace has one), nothing else. Nx writes them before it installs a package
  there; which command leaves them empty is not traced yet (one agent session left 16).
- **This repository's Docker resources** whose checkout directory no longer exists: containers
  (running or not), volumes, networks and images (`packages/db/scripts/orphans.mjs`), of the dev
  Postgres and of the production-image stack alike. It prints each compose project it removed and
  the directory it belonged to.

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

`docker-compose.stack.yml` puts the same labels on the stack's containers and on the images it
builds (`tools/dev-ports.mjs` fills them in for the checkout's own stack project). Images may
outlive their containers (built alone, or kept by a `down`), so their own labels decide: one
labeled with this repository and a checkout directory that is gone is removed, tagged or not,
unless its compose project stays (a container of it runs from a live checkout).

`db-up` labels only a checkout's own compose project. When `COMPOSE_PROJECT_NAME` names another
one (to point several checkouts at one Postgres server, say), what it creates carries empty labels,
since whichever checkout created the server, the others may still use it: such a project is never
pruned, and you remove it yourself (`docker compose -p <name> down -v`) when no checkout needs it.
Pointing `COMPOSE_PROJECT_NAME` at another worktree's own project (`<dir>-<hash>`) ties your
database to that worktree: once its directory is gone, its project goes, unless your checkout
recreated the container since.

Never touched: resources labeled with another repository's common dir, anything of a checkout
whose directory exists, and projects with no resource labeled with this repository: those made by
a bare `docker compose up` (no `db-up` to fill the labels in) or before the labels existed. An
unlabeled resource goes only with an orphaned project. A volume made before the labels keeps its
data and stays unlabeled (Docker volumes cannot be relabeled; compose's "Recreate (data will be
lost)?" defaults to no, and `db-up` runs compose without a terminal, which a test pins). Once
`db-up` has recreated its container with the labels, it goes with that container when the
worktree is deleted; once `pnpm teardown` has removed the container, nothing names it any more.
To clear the unlabeled leftovers once, by hand:

```bash
docker ps -a --filter label=com.docker.compose.project --format '{{.Names}}\t{{.Label "com.docker.compose.project.working_dir"}}'
docker volume ls --filter label=com.docker.compose.project
docker compose -p <project of a deleted worktree> down -v   # or docker rm -f / docker volume rm
```

## Docker's build cache: shared, never pruned for you

Every image build (`docker-build`, `stack-up`, a plain `docker build`) adds to Docker's build
cache, which all checkouts of all repositories on the machine share; `docker system df` shows its
size. Nothing here removes it: a checkout cannot tell its cache entries from another's, and the
next build of the same layers reuses them. Each changed lockfile adds a full install (several
hundred MB), so it grows. Prune it by hand now and then (the next build after it is a cold one):

```bash
docker builder prune --filter until=168h   # entries older than a week
docker builder prune                       # everything no running build uses
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
