# Maintenance automation

What keeps this repository current without a person starting it: Renovate's dependency PRs and the
workflow that regenerates the generated files on them. CI itself (`.github/workflows/ci.yml`) is
`pnpm check` and the jobs `AGENTS.md` and `docs/deployment.md` describe.

| File                                   | What it does                                     | When                                       | In a project made from the template  |
| -------------------------------------- | ------------------------------------------------ | ------------------------------------------ | ------------------------------------ |
| `.github/renovate.json5`               | Renovate's config                                | weekly, once the Renovate App is installed | kept, off until it installs Renovate |
| `.github/workflows/renovate-regen.yml` | `pnpm regen` on Renovate's branches, pushed back | each push to a `renovate/**` branch        | kept, off until it sets up its App   |

<!-- template-only:start -->

The upstream template also runs its releases (`release-please.yml`, `release-please-config.json`,
…: the release PR, the tags and GitHub releases, `CHANGELOG.md`, on each push to main) and a smoke
test (`template-smoke.yml`: bootstraps fresh copies, then every check and the e2e tests, on pull
requests, main and Mondays). Bootstrap removes both: [Maintaining the template](#maintaining-the-template-upstream-only).

<!-- template-only:end -->

## Dependency updates: Renovate

Renovate (the hosted GitHub App) reads `.github/renovate.json5` and does nothing until the App is
installed on the repository. The upstream template installs it at launch. A project turns it on by
installing the App for its repository: the config is there, so Renovate skips its onboarding PR.

- **When:** PRs open on Mondays before 04:00 UTC (`schedule:weekly`), for releases at least 3 days
  old (pnpm's own floor, `minimumReleaseAge` in `pnpm-workspace.yaml`, is 1 day). Commit messages
  are Conventional (`chore(deps): …`, `fix(deps): …`), as release-please reads them.
- **The catalog:** Renovate updates the versions in `pnpm-workspace.yaml` (its catalog and
  `overrides`) and the lockfile; the `catalog:` references in the `package.json` files stay.
- **Caps:** vitest `<5`, typescript `<6.1`, graphql `<17` (catalog and override together: Pothos
  and Yoga are built for 16), pnpm `<12`, Node even majors only (the LTS lines; Renovate's Node
  versioning also waits for the LTS date), postgres `<19` (the production database's major).
- **Not by Renovate:** Nx and `@nx/*`: `nx migrate` runs the migrations a release ships, which a
  version bump skips (skill `nx-upgrade`). A major of `@types/node`: with a Node major, by hand.
- **One PR per group:** Node (`.node-version`, `.prototools`, the Dockerfiles' images,
  `@types/node`), pnpm (`packageManager`, `.prototools`, the Dockerfiles' `pnpm@<version>`, read by
  a regex manager), Vitest, Playwright and Tailwind: what `tools/check-versions.mjs` (part of
  `pnpm check`) requires to agree moves together. oxc (oxlint, oxlint-tsgolint, oxfmt), TanStack
  Start (Start, Router, the SSR query integration) and Drizzle (with `@pothos/plugin-drizzle`) are
  grouped because they are released or built together; no check enforces that.
- **Prereleases:** Drizzle follows npm's `rc` tag (its `latest` is still 0.x, and its other
  prereleases are branch builds); Nitro follows `latest`, where it publishes its betas. Nothing is
  automerged: a person merges every PR.
- **Digests:** Renovate pins the `node` and `postgres` images by digest (`pinDigests`: a tag can
  move, a digest cannot), in the Dockerfiles and both compose files. Until the App is installed
  they are tags only: its first run opens the pin PR, and later PRs update the digests.

On a Renovate PR, CI runs as on any other. A generated file the update changes is committed by
renovate-regen (below), or by hand: check out the branch, `pnpm regen`, commit. A new oxfmt that
formats differently fails the format gate: `pnpm format` on the branch. Check a change to the
config with `pnpm dlx --package renovate renovate-config-validator --strict`;
`tools/test/renovate.test.mjs` pins the rules above. To drop Renovate, delete
`.github/renovate.json5`, `.github/workflows/renovate-regen.yml`, `tools/renovate-regen.mjs` and
`tools/test/renovate.test.mjs`.

## Generated files on Renovate's branches: `renovate-regen`

A new GraphQL Codegen, TanStack Router or drizzle-kit can change committed generated files, and
the drift gate then fails the PR. Hosted Renovate runs no commands of the repository's
(`postUpgradeTasks` are for self-hosted Renovate), so this workflow does: on every push to a
`renovate/**` branch it runs `pnpm regen` and pushes the result back as a commit of its own.

- **Never for a fork:** it runs on `push`, which only branches of this repository trigger
  (Renovate's); a fork's pull request never does. Not `pull_request_target`: that runs with this
  repository's secrets for a fork's PR, and checking out and running the PR's code there is how
  such secrets leak.
- **The update's code holds nothing:** an update is untrusted until reviewed, and `pnpm regen` runs
  it (Codegen, the generators). The `regen` job has no secret and a read-only token
  (`persist-credentials: false`), and uploads the regenerated files as a patch. The `push` job
  installs nothing: it stages the patch in the index only (`git apply --cached`), checks that it
  changes nothing but what `pnpm regen` writes, as plain files
  (`node tools/renovate-regen.mjs check`, run from the commit's own files), commits, then mints a
  token for this repository's contents alone and pushes, not forced. What `pnpm regen` writes: the
  paths of `.agents/generated.json`, of the migrations only new ones (drizzle-kit never changes or
  deletes a committed migration, which may have run on a database already), and on a Playwright or
  drizzle-kit bump what `node tools/vendor-skills.mjs update` writes besides (the versions and
  sha256 pins in `.agents/vendor.json`, the license files it copies, never deleted or executable).
- **No cache crosses from the update to the push:** a job that runs untrusted code can write the
  branch's Actions caches, whatever its steps say: `cache: false` only stops an action's own save,
  and the update's code can reach the runner's cache token itself. A later job restoring such an
  entry would run the attacker's files; `setup-toolchain`'s cache of `~/.proto` holds the node
  binary itself, and the branch's own entries are restored first. So the `push` job restores no
  cache at all: no `actions/cache`, no `setup-toolchain`, but `actions/setup-node` at
  `.node-version` with its caching off, which downloads Node's release. The check it runs imports
  Node's built-in modules and the commit's own `tools/` files only, never the patch's (it is staged,
  not checked out). The `regen` job restores CI's pnpm store from main (restore only) and passes
  `cache: false` to `setup-toolchain`, so it saves nothing a later run could restore by default.
- **Actions pinned to commits:** every `uses:` of the workflow names a commit, with its version
  as a comment (Renovate updates both): a moved tag cannot change what runs next to the App's key.
- **Its own push cancels nothing:** the push of the regen commit starts this workflow again, on
  the same branch; its jobs skip it, and it gets a concurrency group of its own, as in the shared
  one it would cancel the run that made it, still in its last steps. A push by Renovate cancels an
  older run.
- **A GitHub App's token:** GitHub starts no workflow for a push made with `GITHUB_TOKEN`, so CI
  would not run on the regenerated commit.
- **Renovate keeps the branch:** the commit's author is `github-actions[bot]`, which
  `gitIgnoredAuthors` in `renovate.json5` lists, so Renovate still rebases and updates the branch
  (a rebase drops the commit; the next run makes it again). The workflow skips its own pushes.

**One-time setup** (upstream: the maintainer; a project: whoever turns Renovate on):

1. Create a GitHub App (Settings → Developer settings → GitHub Apps → New GitHub App, under the
   account or organization that owns the repository): any name, no webhook (clear "Active"),
   Repository permissions **Contents: Read and write** (upstream, for release-please, also **Pull
   requests** and **Issues: Read and write**), installable only on this account.
2. Note its **Client ID**, and generate a **private key** (a `.pem` file).
3. Install the App on this repository only.
4. In the repository's Settings → Secrets and variables → Actions: the variable
   `AUTOMATION_APP_CLIENT_ID` (the Client ID; not a secret) and the secret
   `AUTOMATION_APP_PRIVATE_KEY` (the whole `.pem`). Then delete the `.pem` file.

Without the variable the workflow starts no job; with the variable and no secret, its `push` job
fails and says why. The App pushes to `renovate/**` only: a ruleset on main is untouched, and one
that covers those branches (signed commits, say) must let the App through.

<!-- template-only:start -->

## Maintaining the template (upstream only)

Bootstrap removes all of this from a copy: the files (`TEMPLATE_ONLY` in `scripts/bootstrap.ts`),
and this section with every other passage of the docs between a `<!-- template-only:start -->` line
and a `<!-- template-only:end -->` line (`withoutTemplateOnly()`; the smoke test checks none is
left). A project keeps CI and the two Renovate files above; this section is the template's record
of what it runs.

**`TEMPLATE_MAINTENANCE`:** a repository variable (Settings → Secrets and variables → Actions →
Variables), `true` on the upstream repository only. Every job of the template-only workflows runs
only where it is set: unlike the repository's name, it survives a rename or a transfer, and
GitHub does not copy variables into repositories created from the template.

**Template smoke test** (`template-smoke.yml`): on pull requests, on main and on Mondays at 05:17
UTC (dependencies move between changes). Two copies, as people get them: `git archive` (GitHub's
tarballs, giget) and the tracked files in one fresh commit ("Use this template"). Each runs
`bootstrap --yes` with a scope longer than `@acme`, then checks that no placeholder survived, that
`.railway/` no longer builds the template, that the template-only files are gone and the kept ones
are not, and the provenance (an archive records its commit; a template copy, null). Then
`pnpm check --all` and `pnpm nx e2e web-e2e` in the copy. Up to 40 minutes. GitHub turns off a
public repository's scheduled workflows after 60 days without activity: turn it back on in the
Actions tab.

**No scheduled agent-config check:** `pnpm agents:nx-check` (with the installed Nx's AI files,
`NX_AI_FILES_USE_LOCAL`) and `pnpm agents:check` read only the commit and its frozen install, so
on an unchanged main they give the result CI gave on its push (`pnpm check` runs both, on every
change). A newer Nx's agent config comes with the Nx upgrade (skill `nx-upgrade`), whose
`pnpm check` compares it.

**Releases** (`release-please.yml`, `release-please-config.json`, `.release-please-manifest.json`):

- On every push to main, release-please updates one release PR: the next version, from the
  Conventional Commits since the last release (`feat` a minor, `fix` a patch, a breaking change a
  minor before 1.0), its `CHANGELOG.md` entry, and the version in `package.json`, `template.json`
  and the manifest. Merging the PR tags its commit `vX.Y.Z` and publishes the GitHub release.
- The manifest starts at 0.0.0, which release-please reads as never released: the first release
  is `initial-version`, 0.1.0.
- `template.json` is the provenance bootstrap copies into a project's `package.json#template`.
  release-please writes its `version`. Its `commit` comes from `git archive` (`export-subst` in
  `.gitattributes`): no release tool can write it, as no file can hold the hash of the commit that
  contains it. A "Use this template" copy records null.
- `CHANGELOG.md` is release-please's: it adds each release above the newest `## <version>`
  heading (in a file with none: on top, below a `# Changelog` it adds, with the old text's `#`
  headings demoted). `.prettierignore` keeps oxfmt off it: its Markdown is not oxfmt's, and the
  format gate would fail the release PR.
- **Token:** with the automation App set up (the variable and secret above; the App with Contents,
  Pull requests and Issues), release-please acts as the App, and CI runs on its PR. Without it,
  it uses `GITHUB_TOKEN`: then turn on "Allow GitHub Actions to create and approve pull requests"
  (Settings → Actions → General), and CI does not run on the release PR, as GitHub starts no
  workflow for what `GITHUB_TOKEN` does.

**At launch, once:** set `TEMPLATE_MAINTENANCE` to `true`; create the automation App with the three
permissions and set `AUTOMATION_APP_CLIENT_ID` and `AUTOMATION_APP_PRIVATE_KEY`; install the
Renovate App on the repository; generate and share the Railway template for the README's button
(`docs/deployment-railway.md`, The "Deploy on Railway" button). Railway's "Wait for CI" waits for
these runs on main too.

<!-- template-only:end -->
