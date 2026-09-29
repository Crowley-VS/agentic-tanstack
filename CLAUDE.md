@AGENTS.md

## Claude Code specifics

- Start `claude` at the repo root so project settings, hooks and skills load.
- Hooks: edits to generated files are blocked (the message names the regen command); edited files are auto-formatted with oxfmt.
- Browser checks: use the `playwright-cli` skill (`pnpm exec playwright cli …`), never `npx playwright-cli`.
