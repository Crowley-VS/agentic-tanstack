---
name: add-ui-component
description: 'Use when adding or updating a shadcn/ui component in packages/ui for the web app. Gives the CLI command that works without a terminal, how to review what it wrote and its dependencies, how apps/web imports and styles it, and its tests: markup in packages/ui, behaviour in a browser test.'
---

# Add a UI component (shadcn/ui)

Read `docs/web.md` first ("UI components come from the shadcn CLI", "Browser tests").
`packages/ui` holds the shadcn/ui components (style radix-nova: `packages/ui/components.json`) and
the Tailwind 4 theme (`packages/ui/src/styles/globals.css`). The pinned CLI writes the components:
never write one by hand.

## 1. Add it with the CLI

- `pnpm --filter @acme/ui exec shadcn add <name> --dry-run` lists what it would write: the new
  file, the components it brings along, and its npm dependencies.
- `pnpm --filter @acme/ui exec shadcn add <name> --overwrite`. Without `--overwrite` the CLI asks
  before overwriting the components already here; with no terminal (an agent's shell) it cannot
  ask, and exits 0 having written nothing, not even the new file.
- `pnpm format`, then `git diff packages/ui` and `git status`. Formatting undoes the CLI's
  restyling of the existing components, so the diff shows only real changes: a newer registry
  version, or a local edit the registry copy dropped. Restore such an edit (today: the `toast`
  re-export at the end of `packages/ui/src/components/sonner.tsx`).
- A new npm dependency lands in `packages/ui/package.json` as `catalog:`, with its version in the
  catalog of `pnpm-workspace.yaml` (`catalogMode: prefer`), and `pnpm-lock.yaml` changes. pnpm
  refuses a version published less than a day ago (`minimumReleaseAge`): wait, never lower it.

## 2. Use it in the web app

- Import it from its own file, `@acme/ui/components/<name>` (the package exports
  `./components/*`: there is no index to update). Inside `packages/ui`, components import each
  other through `#/components/<name>`.
- Tailwind scans `packages/ui/src` and `apps/web/src` without tests (the `@source` lines of
  `globals.css` and `apps/web/src/styles.css`), so the component's classes are generated with no
  config change. A class used only in a test is not generated.
- Colors and radii are the theme's CSS variables (`:root` and `.dark` in `globals.css`): use the
  token classes (`bg-primary`, `text-muted-foreground`), never raw colors. The theme follows the
  system's light or dark setting.

## 3. Test it

- Its markup: a node test next to it, `packages/ui/src/components/<name>.test.tsx`, rendering with
  `renderToStaticMarkup` as `button.test.tsx` does (`pnpm nx run ui:test`). Test what the app
  relies on (a variant, `asChild`), not the registry's own code.
- Its behaviour in the app: a browser test of the web component that uses it
  (`apps/web/src/**/*.browser.test.tsx`: real Chromium with the app's stylesheet;
  `pnpm nx run web:test-browser`). Chromium once per machine and after each Playwright bump:
  `pnpm exec playwright install chromium`. Watch one in a browser:
  `HEADED=1 pnpm nx run web:test-browser --skip-nx-cache --watch`.
- When a browser run warns "optimized dependencies changed. reloading" (flaky), add the new
  dependency to `optimizeDeps.include` in `apps/web/vitest.browser.config.ts` as
  `'@acme/ui > <dependency>'`.

## 4. Prove it

- `pnpm check`; `pnpm nx e2e web-e2e` when a page changed (skill `verify`).
- Look at the page that uses it (skill `run-web`).
