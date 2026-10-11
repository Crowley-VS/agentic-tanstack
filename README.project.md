# acme-app

An Nx monorepo created from the [agentic-tanstack](https://github.com/Crowley-VS/agentic-tanstack) template
(provenance: `package.json#template`), set up so coding agents can work in it reliably.

## Getting started

```bash
test -f .env || cp .env.example .env   # a fresh clone: then set the values it lists; never commit .env
pnpm install # also installs the git hooks (lefthook): format + lint staged files, keep agent config in sync
pnpm check   # the definition of done: lint, formatting, module boundaries, typecheck, tests, generated files, agent config
pnpm ports   # this checkout's ports and database URLs (every git worktree gets its own)
node scripts/setup-agents.mjs   # once per machine: the Claude Code plugins this repo enables, and what they need
```

Each checkout runs its own Postgres container and Nx daemon. Before deleting a worktree, run
`pnpm teardown` in it (stops both, keeps the data, removes its production-image stack);
`pnpm prune:orphans` removes what already deleted worktrees left behind. See
[docs/local-resources.md](docs/local-resources.md).

Agents and humans follow the same rules: see [AGENTS.md](AGENTS.md) (Claude Code reads it through `CLAUDE.md`).
