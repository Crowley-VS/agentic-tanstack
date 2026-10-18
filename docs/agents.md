# Agents in this repo

How coding agents (Claude Code first) work here, for the humans who set them up and review what
they do. Agents follow `AGENTS.md` (Claude Code reads it through `CLAUDE.md`); this page explains
the machinery around it and points at the files that hold it.

## Setup, once per machine

Supported: macOS, Linux and WSL2. Native Windows is not: some package scripts and tests assume a
POSIX shell.

1. `node tools/setup-agents.mjs` (`--check` reports without changing anything). Committed
   settings turn the project's plugins on, but Claude Code downloads none of them by itself: the
   script installs each one (`claude plugin install <id> --scope project`), and checks for
   `typescript-language-server` and Python. It says what it changed and what is left for you.
2. `pnpm exec playwright install chromium`, for browser tests and e2e.
3. Start `claude` at the repo root and trust the folder (next section).

## Trust and where you start

- **Start `claude` at the repo root.** Claude Code reads `.claude/settings.json` (permissions,
  hooks, plugins) only from the directory it starts in, with no fallback to a parent: started in
  `apps/web`, the hooks and permissions here are gone.
- **Trust the folder.** Until you accept the trust dialog, Claude Code ignores the project's allow
  rules, its plugin marketplaces, the hooks in subagent frontmatter (the reviewer's read-only
  hook) and the MCP servers subagents declare (`pnpm pw:agents`). Skills and plugins load once the
  folder is trusted. A worktree shares the trust of its main checkout.
- **Trusting a parent folder is not enough.** If you trusted, say, `~/code`, the allow rules ask
  for the dialog again, and subagent hooks and MCP servers are skipped with no dialog at all: the
  reviewer would then run with plain Bash. Trust the repo itself. `claude -p` never shows the
  dialog: the same parts stay off.

## Finding things: three graphs, grep last

`AGENTS.md` ("How to navigate") has the short form.

| Question                                           | Use                                                | How                                                                                    |
| -------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Which projects exist, who owns a file, what breaks | the Nx project graph                               | `pnpm nx show projects` (`--affected`), `pnpm nx show project <name> --json`           |
| Where a symbol is defined, who calls it, renames   | the TypeScript LSP (plugin `typescript-lsp`)       | go to definition, find references, call hierarchy                                      |
| The API, the pages, the operations                 | the generated maps (read-only, `pnpm regen` makes) | `packages/graphql/schema.graphql`, `apps/web/src/routeTree.gen.ts`, `apps/web/src/gql` |

grep is for strings, config values and comments. For a symbol graph across a large codebase, see
CodeGraph under Opt-ins.

## Skills

- **Task skills** live in `.agents/skills/<name>/SKILL.md`; `pnpm agents:sync` copies them to
  `.claude/skills` (never edit a copy). `AGENTS.md` lists them by task. `pnpm agents:check` (part
  of `pnpm check` and the pre-commit hook) fails when a skill or subagent names a repo path or a
  pnpm script that does not exist, or a subagent preloads a skill that does not.
- **Vendored skills** are upstream's text with this repo's commands: `playwright-cli` from
  playwright-core, and `drizzle`, `drizzle-generate`, `drizzle-hints` from drizzle-kit.
  `.agents/vendor.json` pins each package's version and the upstream file's sha256 and lists the
  rewrites; `node tools/vendor-skills.mjs update` renders the copies from the installed packages,
  and the agents check fails when a copy, the pinned version or upstream's text drifts. To change
  one, change its rewrites and run the update; after a dependency bump, run it and read the diff.
- **Licences**: both are Apache-2.0. `.agents/vendor/playwright-core/` holds Playwright's
  `LICENSE` and `NOTICE`; `.agents/vendor/drizzle-kit/` holds the attribution and changes
  (`LICENSE`) and the licence text (`LICENSE-Apache-2.0`): drizzle-kit ships no licence file.
  Each copy says where it comes from and that it was changed.
- **TanStack Intent** serves the skills the installed TanStack packages (and drizzle-kit) ship,
  for those versions: `pnpm exec intent list`, then `pnpm exec intent load <package>#<skill>`.
  `package.json#intent.skills` lists what may load. `intent install` and `intent hooks` are
  denied: they write download-latest runners into agent config.

## Subagents

Agents in `.claude/agents/`, which Claude Code delegates to by their description (or when you
name one):

- **`reviewer`**: reviews a diff, branch or PR against the `AGENTS.md` invariants and reports
  each finding with a file, a line and the rule. Read-only: Read, Grep, Glob and Bash, where
  `tools/agent-hooks/read-only-bash.mjs` (a PreToolUse hook in its frontmatter) lets through only
  git's read commands, the PR's diff and checks, `pnpm nx show` and checks that change no tracked
  file. Nx checks run alone (`--excludeTaskDependencies --skipSync`): what they depend on
  (`api:print-schema`, `web:codegen`, the route generator, a build) and Nx's sync generators
  rewrite tracked files, which would fix a stale generated file in your tree and hide the finding.
  A subagent's `tools` can only grant or drop all of Bash, hence the hook.
- **`db-migrations`**: makes a schema change and its migration with skills `db-migration` and
  `drizzle` preloaded.
- Playwright's planner, generator and healer: opt-in, below.

**The review loop** (skill `review-loop`, run by `.claude/workflows/review-loop-run.js`) reviews
a PR, posts the findings, fixes the blocking ones and checks the fixes; a human merges.
`tools/agent-hooks/pr-opened.mjs` offers it when a PR opens. To start it without the question,
set `REVIEW_LOOP_AUTO=1` in your own environment (`env` in `.claude/settings.local.json`);
`REVIEW_LOOP_AUTO=0` turns the offer off. Why it is shaped this way:
`docs/decisions/0001-review-loop-convergence.md`.

## Hooks

In `.claude/settings.json`, for every session at the repo root:

- `tools/agent-hooks/guard-paths.mjs` (before an edit): blocks edits to generated files and to
  migrations git tracks (`.agents/generated.json`), naming the command that regenerates them.
- `tools/agent-hooks/format.mjs` (after an edit): formats the file with oxfmt.
- `tools/agent-hooks/pr-opened.mjs` (after `gh pr create` or `gh pr ready`): offers the review
  loop.

Git hooks (`lefthook.yml`, installed by `pnpm install`) format and lint staged files, sync the
skill copies and check the agent config on every commit.

## Plugins on at project scope

`enabledPlugins` in `.claude/settings.json` turns these on for everyone; each machine installs
them once (`node tools/setup-agents.mjs`). Once installed, `claude plugin details <id>` shows
what one adds to each session, in tokens.

| Plugin                                    | What it does                                                                                      | Cost and prerequisites                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `typescript-lsp@claude-plugins-official`  | Code intelligence: definitions, references, diagnostics after edits                               | `typescript-language-server` on PATH; a language server process; diagnostics added to context                         |
| `nx@nx-claude-plugins`                    | Nx skills (workspace, generators, running tasks, CI) and a CI-monitor subagent; the Nx MCP server | Its MCP server starts with `npx nx-mcp@latest` (a download outside this repo's pins); skill listings in every session |
| `context7@claude-plugins-official`        | Current library docs through Context7's hosted MCP server                                         | Network; queries go to a third party; anonymous rate limits unless you set `CONTEXT7_API_KEY`                         |
| `frontend-design@claude-plugins-official` | A skill for distinctive UI work                                                                   | Its skill listing in every session                                                                                    |
| `railway@railway-skills`                  | Railway skills and Railway's hosted MCP server (`docs/deployment-railway.md`)                     | The `railway` CLI and your own login; every Railway command and MCP tool asks first (ask rules)                       |

To turn one off for yourself, set it to `false` in `.claude/settings.local.json` (gitignored),
which wins over the project file:

```json
{ "enabledPlugins": { "context7@claude-plugins-official": false } }
```

## Opt-ins

None of these is on by default; each changes your own setup, not the repo.

- **CodeGraph** (a symbol and call graph for large codebases, over MCP):
  `npm i -g @colbymchenry/codegraph` (upstream's line; its README also has an install script),
  then `codegraph install --target=claude` and `codegraph init` at the repo root. Its installer
  adds a section to this repo's `CLAUDE.md`, a tracked file: keep that out of your commits. Add
  `.codegraph/` (its index) to `.git/info/exclude`. `codegraph uninstall` reverts it.
- **Apollo MCP Server** (the live GraphQL schema: introspect, search, validate):
  `curl -sSL https://mcp.apollo.dev/download/nix/latest | sh`, then a config file with
  `endpoint:` the dev API's URL (`pnpm ports`) and `introspection: { introspect: { enabled: true } }`,
  registered with `claude mcp add apollo -- <path>/apollo-mcp-server <config>` (it speaks stdio by
  default). The dev API allows introspection; production does not (`docs/api.md`). Keep
  `execute` off unless you want agents to run operations.
- **Chrome DevTools MCP** (performance traces, network and console from a real Chrome):
  `claude mcp add chrome-devtools --scope user npx chrome-devtools-mcp@latest` (upstream's line), or
  its plugin: `/plugin marketplace add ChromeDevTools/chrome-devtools-mcp`, then
  `/plugin install chrome-devtools-mcp@chrome-devtools-plugins`. It exposes everything in that
  browser to the agent. Skill `playwright-cli` already drives a browser without it.
- **security-guidance** (pattern warnings on edits, an LLM review of each turn's diff, an agentic
  review on commit): `claude plugin install security-guidance@claude-plugins-official --scope local`.
  Needs Python 3.8+; each review is a model call at your cost (its README lists the switches).
- **`pnpm pw:agents`** (Playwright's test planner, generator and healer as subagents for
  `apps/web-e2e`): `tools/pw-agents.mjs` runs `playwright init-agents --loop=claude` and patches
  what it writes. The agents stay local (`.gitignore`), as do the planner's plans in `specs/`.
  - Trust: each agent starts its own MCP server (the installed Playwright, `run-test-mcp-server`)
    from its frontmatter, which loads only in a trusted folder; their tools can run code in the
    browser (`browser_evaluate`, `browser_run_code_unsafe`) and run the e2e config, which starts
    the e2e servers. In the default mode each MCP tool call asks first unless you allow it.
  - Headless: the patch adds `--headless`, so no window opens (WSL2, SSH, background sessions).
    To watch, remove it from the agent's `args`.
  - `.mcp.json` stays as it was: `init-agents` overwrites it with an npx server for every
    session, which the script undoes. `pnpm pw:agents --mcp-json` adds the patched server to it
    instead (a `.mcp.json` that is not JSON it leaves alone, and exits 1). `.gitignore` lists
    `.mcp.json`: MCP servers are per machine here, and the repo shares none. To share one with
    everyone, remove that line and commit the file deliberately.
  - Playwright picks `apps/web-e2e/src/seed.spec.ts` as the agents' seed test (the first spec
    whose name holds `seed`): it checks the seeded API, so the planner starts on a blank page.
  - Run it again after a Playwright bump.

## Permissions

`.claude/settings.json` is shared by everyone who clones the repo. `tools/test/permissions.test.mjs`
pins what it asks for, and `pnpm agents:check` refuses a wildcard allow rule that approves more
than it seems to (`unsafeAllowRule` in `tools/agents.mjs`: `git log *` also writes files,
`pnpm nx run *` runs any shell command through `--args`).

- **Always asks**: force pushes, pushes to `main`, branch deletions and pushes that run a command
  (`--receive-pack`, `--exec`); every `railway` command, the Railway plugin's API script and MCP
  tools; `pnpm add`, `remove` and `dlx`. An ask rule prompts in every mode, auto included, and no
  allow rule in any file lifts it, so the list holds only what must reach a human. The local dev
  database's reset, studio and psql are not on it: nothing allows them either, so the default mode
  asks, auto mode lets them run, and you can allow them in your `.claude/settings.local.json`
  (exact commands: `db-psql --args='…'` reaches a shell).
- **Allowed**: the checks (`pnpm check`, each project's lint, eslint, typecheck, test and build),
  formatting, regeneration, agent sync and check, the dev database's up, migrate and seed, the dev
  servers, e2e and image builds, the read-only `pr-review` modes, the browser CLI's inspection
  commands, and Intent's `list` and `load`. Exact commands, or wildcards whose arguments reach no
  shell. `pnpm db:generate` exists so a migration can be allowed too (`docs/database.md`).
- **Denied**: reading `.env*`, `npx`, `nx configure-ai-agents`, the download-latest skill
  installers, and edits to generated files (`pnpm agents:sync` renders those rules from
  `.agents/generated.json`).
- **Your own rules** go in `.claude/settings.local.json` (gitignored): allows you want, an `env`
  block, plugins off. Claude Code saves a "don't ask again" answer there too.
- **Agents do not edit `.claude/settings.json`.** `.claude/` is one of Claude Code's protected
  paths: no allow rule approves a write there. Changing what agents may run is a human's call; an
  agent names the rule it needs instead.
