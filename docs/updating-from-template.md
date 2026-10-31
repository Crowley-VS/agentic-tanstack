# Updating from the template

A project made from the agentic-tanstack template does not follow it automatically: bootstrap cut
the link on purpose, so nothing upstream can change your code without a review. This page shows
how to see what changed upstream since your copy, and how to take the changes you want.

## Which version you started from

Bootstrap recorded it in `package.json#template`:

```bash
node -p "require('./package.json').template"   # { repo, version, commit }
```

`version` is the template release you copied (`0.0.0` for a copy taken before the first release)
and `commit` the upstream commit, when the release recorded one. Bootstrap's own commit says the
same: `chore: bootstrap from <repo>@<version>` (`git log --grep 'bootstrap from'`). When you take a
later release, update these two fields too, so the next comparison starts from there.

## See what changed

Add the template as a second remote and fetch its history and release tags (your project and the
template share no history, which is fine for what follows):

```bash
git remote add template https://github.com/Crowley-VS/agentic-tanstack.git
git fetch template --tags
```

Your starting point, `<old>`, is the release tag of your `version`, or the `commit`. A copy taken
before the first release has neither (`0.0.0`, no commit): find the upstream commit it copied. A
"Use this template" copy's first commit holds upstream's files unchanged, so it has the same tree:

```bash
tree=$(git rev-parse "$(git rev-list --max-parents=0 HEAD | tail -n 1)^{tree}")
git log template/main --format='%H %T' | awk -v t="$tree" '$2 == t { print $1 }'
```

When that prints nothing (a tarball copy, whose first commit is bootstrap's own), take the last
upstream commit before your bootstrap commit, and check its date against the day you downloaded
the copy:

```bash
bootstrapped=$(git log -1 --format=%cI --grep 'bootstrap from')
git log -1 --format='%H %cs' --before="$bootstrapped" template/main
```

Then, with `<new>` the release you want:

```bash
git log --oneline <old>..<new>                  # the commits, Conventional Commit titles
git diff --stat <old> <new>                     # the files
git diff <old> <new> -- docs/ .agents/skills/   # one area
```

The template's `CHANGELOG.md` and its GitHub releases summarize each release from those commits.
Read this page as `<new>` has it, too: `git show <new>:docs/updating-from-template.md`.

## Take a change

Upstream files still hold the placeholder scope and name that bootstrap replaced in yours, so a
patch from upstream must be renamed the same way before it applies, and must leave out the files
your project does not take (listed below). Two shell helpers do both; put your scope and name in
place of `@my-org` and `my-app` (the brackets keep the pattern from matching itself), and run them
at the repository root, which their paths start from:

```bash
# git <command> <args>, limited to the files a project takes from upstream
upstream() {
  git "$@" -- . ':(exclude)pnpm-lock.yaml' ':(exclude)README.md' ':(exclude)README.project.md' \
    ':(exclude)template.json' ':(exclude)scripts' ':(exclude)CHANGELOG.md' \
    ':(exclude)CODE_OF_CONDUCT.md' ':(exclude)CONTRIBUTING.md' ':(exclude)SECURITY.md' \
    ':(exclude).github/ISSUE_TEMPLATE' ':(exclude).github/workflows/template-smoke.yml' \
    ':(exclude).github/workflows/release-please.yml' ':(exclude).prettierignore' \
    ':(exclude)release-please-config.json' ':(exclude).release-please-manifest.json'
}
rescope() { sed -e 's#@acme[/]#@my-org/#g' -e 's#acme[-]app#my-app#g'; }

# one upstream commit, keeping its message and author ('<sha>^!' is exactly that commit)
upstream format-patch --stdout '<sha>^!' | rescope | git am

# or a whole range, as one change to review
upstream diff <old> <new> | rescope | git apply --reject
```

`git apply --reject` applies every hunk that fits and leaves a `.rej` file next to each one that
does not; resolve those by hand, then delete the `.rej` files. A hunk fails where you changed the
same lines, and where bootstrap reformatted a line that a longer scope pushed over the line width.
A file you deleted fails with `error: <file>: No such file or directory`; `git apply` exits 1
after applying the rest. A `git am` that stops: `git am --show-current-patch=diff`, then fix and
`git am --continue`, or `git am --abort`.

What `upstream` leaves out, and what to do instead:

- **Template-only files**, which bootstrap removed: `CHANGELOG.md`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/`, `template.json`, `scripts/`, and
  the template's own maintenance workflows and their config. Bootstrap's `TEMPLATE_ONLY` list
  names them. When `<new>` adds one (`git show <new>:scripts/bootstrap.ts`), add it to `upstream`
  too: a patch creates every file upstream added, and a template workflow would then run in your
  repository.
- **`README.md`** and **`README.project.md`**: upstream's `README.md` is the template's front page,
  and yours came from its `README.project.md`. Read upstream's changes to that file
  (`git diff <old> <new> -- README.project.md`) and copy what you want into your `README.md`.
- **The lockfile**: `pnpm install` rewrites `pnpm-lock.yaml` from the changed `package.json`
  files.

What it takes, with care:

- **Generated files** (`.agents/generated.json` lists them): never resolve a rejected hunk in one
  by hand; `pnpm regen` rewrites them from their sources.
- **Migrations are the exception**: take upstream's new folders in `packages/db/migrations/`
  exactly as committed, and never regenerate them. drizzle-kit would write a regenerated one under
  another name and id, so your migration history would no longer match upstream's, and a
  hand-written one (a backfill, `pnpm db:generate <name> --custom`) cannot be regenerated at all.
- **`.railway/railway.ts`'s `REPO`**: yours names your repository; keep it.

Then prove it as for any change:

```bash
pnpm install
pnpm regen
pnpm check
pnpm nx e2e web-e2e     # when web, the API or the specs changed
```

## Coming: syncing the agent layer

The agent layer (hooks, `pnpm check`, the agent-config tooling, the generic skills; `.agents/kit.json`
lists the files and the `AGENTS.md` sections it owns) is meant to come from a generic template,
agentic-nx-monorepo, which is planned. A `kit-sync` script will then copy those files and sections
from a tagged release of it, and a check will say when they drift. Until then, take agent-layer
changes from this template as above.
