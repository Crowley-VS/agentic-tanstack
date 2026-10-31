# 0010 — oxlint and oxfmt, with ESLint only for boundaries and GraphQL

- **Status:** accepted (2026-09-29; spike S4 passed with caveats)
- **Applies to:** `.oxlintrc.json`, `.oxfmtrc.json`, `eslint.config.mjs`, the `lint` and `eslint`
  targets, the edit hook and the pre-commit hook

## Context

An agent lints and formats after nearly every edit, so the tools must answer in seconds; a slow
linter is one an agent learns to skip. Two checks matter more than speed, though: Nx's module
boundaries, and GraphQL operations validated against the schema. Neither exists in oxlint.

## Decision

- **oxlint** (`^1.85`, through `@nx/oxlint`) owns the `lint` target, type-aware
  (`oxlint-tsgolint`): correctness rules as errors, suspicious ones as warnings, plus
  `no-floating-promises`, `no-misused-promises` and `import/no-cycle`.
- **oxfmt** (`^0.70`) is the only formatter: the edit hook formats each edited file, the pre-commit
  hook the staged ones, and `pnpm check` fails on any unformatted file. Generated files are ignored
  (the ignore lists are rendered from `.agents/generated.json`).
- **ESLint 10** runs as a separate `eslint` target with two jobs only:
  `@nx/enforce-module-boundaries` (the tag rules, [architecture.md](../architecture.md)) and
  `@graphql-eslint`'s operation rules on the web app's `graphql()` documents.
- **Lint only through Nx** (`pnpm nx run <project>:eslint`): the boundary rule reads Nx's project
  graph and silently checks nothing without it (S4). `nx.json` lists `schema.graphql` among the
  `eslint` inputs, so a schema change re-lints the operations.

## Consequences

- Lint and format results arrive in seconds; ESLint's narrower job keeps its cost down too.
- Two linters to configure, each with a clear scope; a rule oxlint gains later can move over.
- oxfmt is pre-1.0: a version can change the output, and `pnpm format` re-formats everything after
  a bump.
- Formatting is never a review topic: the hooks format edits and commits, and `pnpm check` catches
  a commit that bypassed them.

## Alternatives considered

- **ESLint + Prettier alone**: one familiar toolchain, but slower on every edit, for agents and in
  CI.
- **Biome**: fast, lint and format in one, but it has no Nx module-boundary rule and does not
  check operations against a GraphQL schema either, so ESLint would stay anyway.
- **oxlint's boundaries bridge instead of ESLint**: possible (the planned generic template may use
  it); here ESLint is needed for `@graphql-eslint` regardless.
