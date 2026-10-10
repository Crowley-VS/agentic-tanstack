---
name: playwright-cli
description: 'Automate browser interactions, test web pages and work with Playwright tests. Here every command is `pnpm exec playwright cli <command>` (the pinned Playwright): never npx or a global playwright-cli.'
allowed-tools: 'Bash(pnpm exec playwright cli --help *) Bash(pnpm exec playwright cli open) Bash(pnpm exec playwright cli open --browser=chromium) Bash(pnpm exec playwright cli goto *) Bash(pnpm exec playwright cli snapshot) Bash(pnpm exec playwright cli find *) Bash(pnpm exec playwright cli click *) Bash(pnpm exec playwright cli dblclick *) Bash(pnpm exec playwright cli fill *) Bash(pnpm exec playwright cli type *) Bash(pnpm exec playwright cli press *) Bash(pnpm exec playwright cli hover *) Bash(pnpm exec playwright cli select *) Bash(pnpm exec playwright cli check *) Bash(pnpm exec playwright cli uncheck *) Bash(pnpm exec playwright cli go-back) Bash(pnpm exec playwright cli go-forward) Bash(pnpm exec playwright cli reload) Bash(pnpm exec playwright cli tab-list) Bash(pnpm exec playwright cli console *) Bash(pnpm exec playwright cli requests *) Bash(pnpm exec playwright cli list) Bash(pnpm exec playwright cli close) Bash(pnpm exec playwright cli close-all)'
---

<!-- Vendored from playwright-core@1.63.0 (lib/tools/skills/playwright-cli/SKILL.md), Apache-2.0: .agents/vendor/playwright-core/. Changed for this repo by the rewrites in .agents/vendor.json. Do not edit this copy: change its rewrites, then run `node tools/vendor-skills.mjs update`. -->

# Browser Automation with playwright-cli

## Quick start

```bash
# open new browser
pnpm exec playwright cli open
# navigate to a page
pnpm exec playwright cli goto https://playwright.dev
# interact with the page using refs from the snapshot
pnpm exec playwright cli click e15
pnpm exec playwright cli type "page.click"
pnpm exec playwright cli press Enter
# take a screenshot (rarely used, as snapshot is more common)
pnpm exec playwright cli screenshot
# close the browser
pnpm exec playwright cli close
```

## Commands

### Core

```bash
pnpm exec playwright cli open
# open and navigate right away
pnpm exec playwright cli open https://example.com/
pnpm exec playwright cli goto https://playwright.dev
pnpm exec playwright cli type "search query"
pnpm exec playwright cli click e3
pnpm exec playwright cli dblclick e7
# --submit presses Enter after filling the element
pnpm exec playwright cli fill e5 "user@example.com"  --submit
pnpm exec playwright cli drag e2 e8
# drop files or data onto an element (from outside the page)
pnpm exec playwright cli drop e4 --path=./image.png
pnpm exec playwright cli drop e4 --data="text/plain=hello world"
pnpm exec playwright cli hover e4
pnpm exec playwright cli select e9 "option-value"
pnpm exec playwright cli upload ./document.pdf
pnpm exec playwright cli check e12
pnpm exec playwright cli uncheck e12
pnpm exec playwright cli snapshot
# search the snapshot for text or a regexp, returns matching nodes with surrounding context
pnpm exec playwright cli find "Sign in"
pnpm exec playwright cli find --regex "Sign (in|up)"
# wrap the regexp in slashes to add flags, e.g. /i for case-insensitive
pnpm exec playwright cli find --regex "/sign (in|up)/i"
pnpm exec playwright cli eval "document.title"
pnpm exec playwright cli eval "el => el.textContent" e5
# get element id, class, or any attribute not visible in the snapshot
pnpm exec playwright cli eval "el => el.id" e5
pnpm exec playwright cli eval "el => el.getAttribute('data-testid')" e5
pnpm exec playwright cli dialog-accept
pnpm exec playwright cli dialog-accept "confirmation text"
pnpm exec playwright cli dialog-dismiss
pnpm exec playwright cli resize 1920 1080
pnpm exec playwright cli close
```

### Navigation

```bash
pnpm exec playwright cli go-back
pnpm exec playwright cli go-forward
pnpm exec playwright cli reload
```

### Keyboard

```bash
pnpm exec playwright cli press Enter
pnpm exec playwright cli press ArrowDown
pnpm exec playwright cli keydown Shift
pnpm exec playwright cli keyup Shift
```

### Mouse

```bash
pnpm exec playwright cli mousemove 150 300
pnpm exec playwright cli mousedown
pnpm exec playwright cli mousedown right
pnpm exec playwright cli mouseup
pnpm exec playwright cli mouseup right
pnpm exec playwright cli mousewheel 0 100
```

### Save as

```bash
pnpm exec playwright cli screenshot
pnpm exec playwright cli screenshot e5
pnpm exec playwright cli screenshot --filename=page.png
pnpm exec playwright cli screenshot --hires
pnpm exec playwright cli pdf --filename=page.pdf
```

### Tabs

```bash
pnpm exec playwright cli tab-list
pnpm exec playwright cli tab-new
pnpm exec playwright cli tab-new https://example.com/page
pnpm exec playwright cli tab-close
pnpm exec playwright cli tab-close 2
pnpm exec playwright cli tab-select 0
```

### Storage

```bash
pnpm exec playwright cli state-save
pnpm exec playwright cli state-save auth.json
pnpm exec playwright cli state-load auth.json

# Cookies
pnpm exec playwright cli cookie-list
pnpm exec playwright cli cookie-list --domain=example.com
pnpm exec playwright cli cookie-get session_id
pnpm exec playwright cli cookie-set session_id abc123
pnpm exec playwright cli cookie-set session_id abc123 --domain=example.com --httpOnly --secure
pnpm exec playwright cli cookie-delete session_id
pnpm exec playwright cli cookie-clear

# LocalStorage
pnpm exec playwright cli localstorage-list
pnpm exec playwright cli localstorage-get theme
pnpm exec playwright cli localstorage-set theme dark
pnpm exec playwright cli localstorage-delete theme
pnpm exec playwright cli localstorage-clear

# SessionStorage
pnpm exec playwright cli sessionstorage-list
pnpm exec playwright cli sessionstorage-get step
pnpm exec playwright cli sessionstorage-set step 3
pnpm exec playwright cli sessionstorage-delete step
pnpm exec playwright cli sessionstorage-clear
```

### Network

```bash
pnpm exec playwright cli route "**/*.jpg" --status=404
pnpm exec playwright cli route "https://api.example.com/**" --body='{"mock": true}'
pnpm exec playwright cli route-list
pnpm exec playwright cli unroute "**/*.jpg"
pnpm exec playwright cli unroute
```

### DevTools

```bash
pnpm exec playwright cli console
pnpm exec playwright cli console warning
pnpm exec playwright cli requests
pnpm exec playwright cli request 5
pnpm exec playwright cli run-code "async page => await page.context().grantPermissions(['geolocation'])"
pnpm exec playwright cli run-code --filename=script.js
pnpm exec playwright cli tracing-start
pnpm exec playwright cli tracing-stop

# record user actions in the browser, print them as Playwright code on stop
pnpm exec playwright cli recording-start
pnpm exec playwright cli recording-stop

pnpm exec playwright cli video-start video.webm
pnpm exec playwright cli video-chapter "Chapter Title" --description="Details" --duration=2000
pnpm exec playwright cli video-stop

# annotate each subsequent action (click, type, ...) with a callout naming the action and highlighting the target
pnpm exec playwright cli video-show-actions --duration=600 --position=top-right
pnpm exec playwright cli video-hide-actions

# launch the dashboard for UI review / design feedback — user annotates the page, you receive the annotated screenshot, snapshot, and notes
pnpm exec playwright cli show --annotate

# generate a Playwright locator for an element from its ref or selector
pnpm exec playwright cli generate-locator e5 --raw

# show a persistent highlight overlay for an element, optionally with a custom style
pnpm exec playwright cli highlight e5
pnpm exec playwright cli highlight e5 --style="outline: 3px dashed red"
# hide a single element highlight, or all page highlights when no target is given
pnpm exec playwright cli highlight e5 --hide
pnpm exec playwright cli highlight --hide
```

## Raw output

The global `--raw` option strips page status, generated code, and snapshot sections from the output, returning only the result value. Use it to pipe command output into other tools. Commands that don't produce output return nothing.

```bash
pnpm exec playwright cli --raw eval "JSON.stringify(performance.timing)" | jq '.loadEventEnd - .navigationStart'
pnpm exec playwright cli --raw eval "JSON.stringify([...document.querySelectorAll('a')].map(a => a.href))" > links.json
pnpm exec playwright cli --raw snapshot > before.yml
pnpm exec playwright cli click e5
pnpm exec playwright cli --raw snapshot > after.yml
diff before.yml after.yml
TOKEN=$(pnpm exec playwright cli --raw cookie-get session_id)
pnpm exec playwright cli --raw localstorage-get theme
```

For structured output wrapping every reply as JSON, pass --json
```bash
pnpm exec playwright cli list --json
```

## Open parameters
```bash
# Use specific browser when creating session
pnpm exec playwright cli open --browser=chrome
pnpm exec playwright cli open --browser=firefox
pnpm exec playwright cli open --browser=webkit
pnpm exec playwright cli open --browser=msedge

# Emulate a generic mobile device (Pixel 10 for Chromium, iPhone 17 for WebKit).
# Prefer this when a mobile layout is acceptable: mobile pages are usually
# lighter, so snapshots are smaller and cheaper.
pnpm exec playwright cli open --mobile
pnpm exec playwright cli open --device="iPhone 15"

# Use persistent profile (by default profile is in-memory)
pnpm exec playwright cli open --persistent
# Use persistent profile with custom directory
pnpm exec playwright cli open --profile=/path/to/profile

# Connect to browser via Playwright Extension
pnpm exec playwright cli attach --extension=chrome

# Connect to a running Chrome or Edge by channel name
pnpm exec playwright cli attach --cdp=chrome
pnpm exec playwright cli attach --cdp=msedge

# Connect to a running browser via CDP endpoint
pnpm exec playwright cli attach --cdp=http://localhost:9222

# Start with config file
pnpm exec playwright cli open --config=my-config.json

# Close the browser
pnpm exec playwright cli close
# Detach from an attached browser (leaves the external browser running)
pnpm exec playwright cli -s=msedge detach
# Delete user data for the default session
pnpm exec playwright cli delete-data
```

## URLs with `&` on Windows

On Windows, `cmd.exe` and PowerShell treat `&` as a command separator, so URLs with multiple query parameters get truncated before `playwright-cli` runs. Escape `&` with `^&` in `cmd.exe`, or use `--%` in PowerShell:

```batch
pnpm exec playwright cli goto "https://example.com/?a=1^&b=2"
```

```powershell
pnpm exec playwright cli --% goto "https://example.com/?a=1&b=2"
```

## Snapshots

After each command, pnpm exec playwright cli provides a snapshot of the current browser state.

```bash
> pnpm exec playwright cli goto https://example.com
### Page
- Page URL: https://example.com/
- Page Title: Example Domain
### Snapshot
[Snapshot](.playwright-cli/page-2026-02-14T19-22-42-679Z.yml)
```

You can also take a snapshot on demand using `pnpm exec playwright cli snapshot` command. All the options below can be combined as needed.

```bash
# default - save to a file with timestamp-based name
pnpm exec playwright cli snapshot

# save to file, use when snapshot is a part of the workflow result
pnpm exec playwright cli snapshot --filename=after-click.yaml

# snapshot an element instead of the whole page
pnpm exec playwright cli snapshot "#main"

# limit snapshot depth for efficiency, take a partial snapshot afterwards
pnpm exec playwright cli snapshot --depth=4
pnpm exec playwright cli snapshot e34

# include each element's bounding box as [box=x,y,width,height]
pnpm exec playwright cli snapshot --boxes

# search a large snapshot instead of capturing it all — returns matching nodes
# with 3 lines of context around each match (like grep -C)
pnpm exec playwright cli find "Add to cart"
pnpm exec playwright cli find --regex "\\$[0-9]+\\.[0-9]{2}"
```

## Targeting elements

By default, use refs from the snapshot to interact with page elements.

```bash
# get snapshot with refs
pnpm exec playwright cli snapshot

# interact using a ref
pnpm exec playwright cli click e15
```

You can also use css selectors or Playwright locators.

```bash
# css selector
pnpm exec playwright cli click "#main > button.submit"

# role locator
pnpm exec playwright cli click "getByRole('button', { name: 'Submit' })"

# test id
pnpm exec playwright cli click "getByTestId('submit-button')"
```

## Browser Sessions

```bash
# create new browser session named "mysession" with persistent profile
pnpm exec playwright cli -s=mysession open example.com --persistent
# same with manually specified profile directory (use when requested explicitly)
pnpm exec playwright cli -s=mysession open example.com --profile=/path/to/profile
pnpm exec playwright cli -s=mysession click e6
pnpm exec playwright cli -s=mysession close  # stop a named browser
pnpm exec playwright cli -s=mysession delete-data  # delete user data for persistent session

pnpm exec playwright cli list
# Close all browsers
pnpm exec playwright cli close-all
# Forcefully kill all browser processes
pnpm exec playwright cli kill-all
```

## Installation

Playwright is a pinned dependency of this repo (the pnpm catalog). Run every command from the
repo root as `pnpm exec playwright cli <command>`: never `npx`, `npm install -g @playwright/cli`
or a global `playwright-cli`, which run another version.

- `pnpm exec playwright cli open --browser=chromium` opens the Chromium that
  `pnpm exec playwright install chromium` installs (once per machine, and after each Playwright
  bump); a bare `open` launches the installed Google Chrome.
- This checkout's URLs (the dev web server, the e2e one): `pnpm ports`. Skill `run-web` starts
  the servers.
- Snapshots, console logs and other output land in `.playwright-cli/` (gitignored).
- Close the browser when you are done: `pnpm exec playwright cli close` (`close-all` for every
  session). Its daemon keeps running until then.

## Example: Form submission

```bash
pnpm exec playwright cli open https://example.com/form
pnpm exec playwright cli snapshot

pnpm exec playwright cli fill e1 "user@example.com"
pnpm exec playwright cli fill e2 "password123"
pnpm exec playwright cli click e3
pnpm exec playwright cli snapshot
pnpm exec playwright cli close
```

## Example: Multi-tab workflow

```bash
pnpm exec playwright cli open https://example.com
pnpm exec playwright cli tab-new https://example.com/other
pnpm exec playwright cli tab-list
pnpm exec playwright cli tab-select 0
pnpm exec playwright cli snapshot
pnpm exec playwright cli close
```

## Example: Debugging with DevTools

```bash
pnpm exec playwright cli open https://example.com
pnpm exec playwright cli click e4
pnpm exec playwright cli fill e7 "test"
pnpm exec playwright cli console
pnpm exec playwright cli requests
pnpm exec playwright cli close
```

```bash
pnpm exec playwright cli open https://example.com
pnpm exec playwright cli tracing-start
pnpm exec playwright cli click e4
pnpm exec playwright cli fill e7 "test"
pnpm exec playwright cli tracing-stop
pnpm exec playwright cli close
```

## Example: Interactive session

Ask the user for UI review or design feedback. The user draws boxes on the live page and types comments; you receive the annotated screenshot, the snapshot of the marked region, and the user's notes. Use this whenever the user asks for "UI review", "design feedback", or to "ask the user what they think / want / mean":

```bash
pnpm exec playwright cli open https://example.com
pnpm exec playwright cli show --annotate
```

## Specific tasks

Playwright ships more guides with this skill, for the installed version: the `references/`
folder next to the `Agent skill:` path that `pnpm exec playwright cli --help` prints (request
mocking, running code, sessions, storage state, test generation, tracing, video, element
attributes). They spell commands `playwright-cli …` and `npx playwright …`: run them as
`pnpm exec playwright cli …` and `pnpm exec playwright …`.

Run and debug this repo's e2e specs through Nx, never `npx playwright test`: skill `e2e-test`.
