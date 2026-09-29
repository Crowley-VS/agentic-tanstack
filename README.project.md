# acme-app

An Nx monorepo created from the [agentic-tanstack](https://github.com/Crowley-VS/agentic-tanstack) template
(provenance: `package.json#template`), set up so coding agents can work in it reliably.

## Getting started

```bash
test -f .env || cp .env.example .env   # a fresh clone: then set the values it lists; never commit .env
pnpm install # also installs the git hooks (lefthook): format + lint staged files, keep agent config in sync
pnpm check   # the definition of done: lint, formatting, module boundaries, typecheck, tests, generated files, agent config
pnpm ports   # this checkout's ports and database URLs (every git worktree gets its own)
```

Agents and humans follow the same rules: see [AGENTS.md](AGENTS.md) (Claude Code reads it through `CLAUDE.md`).
