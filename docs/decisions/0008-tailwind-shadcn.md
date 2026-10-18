# 0008 — Tailwind CSS 4 and shadcn/ui

- **Status:** accepted (2026-09-29)
- **Applies to:** `packages/ui`, `apps/web` (styles and components)

## Context

Agents write most of the UI. They do best with the styling approach they have seen most, and with
components whose code they can read and change, rather than a library's props documentation they
have to guess at. The components must be accessible by default and themable.

## Decision

- **Tailwind CSS 4** (`tailwindcss` and `@tailwindcss/vite` 4.3.3, pinned exactly together), its
  theme in `packages/ui/src/styles/globals.css`, which each app imports next to `@source` lines
  for its own code (`apps/web/src/styles.css`).
- **shadcn/ui** components (the `radix-nova` style: Radix primitives, Lucide icons) live as source
  in `packages/ui/src/components`, written by the pinned shadcn CLI (4.21.0), never by hand:
  `pnpm --filter @acme/ui exec shadcn add <name> --overwrite`, then `pnpm format` and
  `git diff packages/ui` (skill `add-ui-component`, [web.md](../web.md)).
- `packages/ui` is a `type:ui` project: the web app imports it; it imports only utilities.

## Consequences

- The component code is the repository's: a change is a diff, not a fork of a dependency.
- Updating a component means re-running the CLI and reviewing what it rewrote; a local edit the
  registry copy lacks must be restored by hand (today one: the `toast` re-export in `sonner.tsx`).
- Without a terminal the CLI writes nothing unless `--overwrite` is passed, which is why the skill
  names it.
- Tailwind only generates classes it finds in the scanned sources: a class used only in a test
  does nothing.

## Alternatives considered

- **A component library you install** (MUI, Mantine, Chakra): fast to start, but its code is not
  yours to change, and agents work against its API documentation instead of the source.
- **CSS Modules or vanilla-extract**: fine, with less agent familiarity and more files per
  component.
- **Tailwind 3**: superseded; 4 needs no JavaScript config and works through its Vite plugin.
