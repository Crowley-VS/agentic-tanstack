# Contributing to agentic-tanstack

Thanks for helping. This file is about changes to **the template itself**. A project made from it
does not get this file (bootstrap removes it): its own rules are in `AGENTS.md`.

## Before you start

- **A bug:** open an issue with the bug report form: what you ran, what happened, and your Node,
  pnpm, Docker and OS versions.
- **A feature or a change of direction** (a new dependency, another default, a new skill): open a
  feature request or a Discussion first. The template stays small on purpose: one reference
  feature, one way to do each thing, every rule enforced by a check. A proposal that adds a second
  way, or a rule no check enforces, is a harder sell.
- **A vulnerability:** never in a public issue; see [SECURITY.md](SECURITY.md).
- **Small fixes** (a typo, a broken link, a wrong command in a doc) need no issue: open a pull
  request.

## Set up

You need Node 24, pnpm 11, Docker Engine with Compose v2 (running) and git, on macOS, Linux or WSL2.
Fork the repository and clone your fork. Do **not** run `node scripts/bootstrap.mjs` in it: that
turns a copy into a project and deletes the template's own files.

```bash
cp .env.example .env    # then set the values it lists; never commit .env
node -p "require('node:crypto').randomBytes(32).toString('hex')"   # a value for INTERNAL_API_SECRET
pnpm install
pnpm exec playwright install chromium   # browser and e2e tests, once per machine
pnpm check                              # should pass before you change anything
```

The commands, the invariants and the doc to read for each area are in [AGENTS.md](AGENTS.md); the
same rules apply to people and agents.

## Make the change

- **"Done" means the [`AGENTS.md` "Done means"](AGENTS.md#done-means) list:** `pnpm check` passes,
  plus the stack's extra checks for what you touched (`pnpm nx e2e web-e2e` for routes, UI or the
  API; `pnpm nx run web-e2e:e2e-stack` for a Dockerfile, `.dockerignore` or
  `docker-compose.stack.yml`), and you ran a change of behaviour and saw it work. Never weaken a
  test or a rule to make a check pass: fix the cause.
- **Bootstrap** (`scripts/bootstrap.ts`): also run `pnpm nx run scripts:test --skip-nx-cache`.
- **Generated files** (`.agents/generated.json` lists them) are never edited by hand: change the
  source and run the command it names, or `pnpm regen`.
- **Skills**: edit `.agents/skills/<name>/SKILL.md`, then `pnpm agents:sync`.
- **Docs**: check that every path and command you write exists (`pnpm check` checks the relative
  links and their anchors).
- Turn anything you verified by hand into a test.

## Pull requests

1. One concern per pull request, on a branch of your fork.
2. [Conventional Commits](https://www.conventionalcommits.org/) titles and messages (`feat:`,
   `fix:`, `docs:`, `test:`, `chore:`…): release notes are written from them.
3. Open the pull request against `main`. The template asks for a **summary** (what and why) and a
   **test plan** (the commands you ran and what they showed). Keep exact test counts out of it.
4. CI runs `pnpm check`, the e2e specs and, when web or api changed, the image checks. Forks run
   it with no secrets.
5. **The review loop is optional for you.** The maintainers run the agent review loop (skill
   `review-loop`) on pull requests, which posts its findings as review comments; it needs Claude
   Code and runs many agents, so outside contributors need not run it. Answer its findings like
   any other review.
6. A maintainer merges. The template's own files (this one, the issue forms, the template smoke
   test) are kept out of projects by bootstrap's `TEMPLATE_ONLY` list: add a new template-only file
   there, with a test in `scripts/test/bootstrap.test.mjs`.

## Repository settings

Some of the template's files rely on settings of the repository itself, which no file can set. The
maintainers keep them on in the upstream repository, and so should anyone who maintains a fork as
a template of their own:

- **Public, and a template repository** (Settings → General): the README's "Use this template"
  needs both.
- **Discussions** on: blank issues are off, and the issue forms' "Questions and ideas" link opens
  them (`.github/ISSUE_TEMPLATE/config.yml`).
- **Private vulnerability reporting** on (Settings → Security): [SECURITY.md](SECURITY.md) and the
  issue forms send every report there.
- **The Actions variable `TEMPLATE_MAINTENANCE` set to `true`** (Settings → Secrets and variables
  → Actions → Variables): the template smoke test (`.github/workflows/template-smoke.yml`) runs
  only where it is set. Repositories made from the template do not get it.

To check them: `gh repo view --json visibility,isTemplate,hasDiscussionsEnabled`,
`gh api 'repos/{owner}/{repo}/private-vulnerability-reporting'` and `gh variable list`.

## Licence of contributions

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE) of
this repository. The vendored skills in `.agents/skills/{playwright-cli,drizzle,drizzle-generate,drizzle-hints}`
are upstream's Apache-2.0 text: change them only through their rewrites in `.agents/vendor.json`
(`node tools/vendor-skills.mjs update`).

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
