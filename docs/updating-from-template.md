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

Then, with `<old>` your starting point (the release tag of your `version`, or the `commit`) and
`<new>` the release you want:

```bash
git log --oneline <old>..<new>                  # the commits, Conventional Commit titles
git diff --stat <old> <new>                     # the files
git diff <old> <new> -- docs/ .agents/skills/   # one area
```

The template's `CHANGELOG.md` and its GitHub releases summarize each release from those commits.

## Take a change

Upstream files still hold the placeholder scope and name that bootstrap replaced in yours, so a
patch from upstream must be renamed the same way before it applies. With your scope and name in
place of `@my-org` and `my-app` (the brackets keep the pattern from matching itself):

```bash
# one upstream commit, keeping its message and author
git format-patch -1 --stdout <sha> \
  | sed -e 's#@acme[/]#@my-org/#g' -e 's#acme[-]app#my-app#g' \
  | git am

# or a whole range, as one change to review
git diff <old> <new> -- . ':(exclude)pnpm-lock.yaml' ':(exclude)README.md' \
  | sed -e 's#@acme[/]#@my-org/#g' -e 's#acme[-]app#my-app#g' \
  | git apply --reject
```

`git apply --reject` applies every hunk that fits and leaves a `.rej` file next to each one that
does not; resolve those by hand, then delete the `.rej` files. A hunk fails where you changed the
same lines, and where bootstrap reformatted a line that a longer scope pushed over the line width.
It reports `error: <file>: No such file or directory` for each template-only file the range
touched (bootstrap removed them: below) and exits 1, after applying the rest. A `git am` that
stops: `git am --show-current-patch=diff`, then fix and `git am --continue`, or `git am --abort`.

Leave out, or skip when they fail to apply:

- **Template-only files**, which bootstrap removed: `CHANGELOG.md`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/`, `template.json`, `scripts/`, and
  the template's maintenance workflows (`.github/workflows/template-smoke.yml`, and the others
  `TEMPLATE_ONLY` lists in the template's `scripts/bootstrap.ts`).
- **`README.md`**: upstream's is the template's front page; yours came from its
  `README.project.md`, so take changes from that file instead.
- **The lockfile and generated files**: never patch them. After the patch, `pnpm install` rewrites
  `pnpm-lock.yaml` from the changed `package.json` files, and `pnpm regen` rewrites the generated
  files (`.agents/generated.json` lists them).
- **`.railway/railway.ts`'s `REPO`**: yours names your repository.

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
