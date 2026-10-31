#!/usr/bin/env node
// Once per machine, from the repo root: what Claude Code needs here that a clone does not bring.
//
//   node tools/setup-agents.mjs           set it up, saying what it changes
//   node tools/setup-agents.mjs --check   report only: runs nothing that changes anything
//
// 1. The Claude Code CLI (`claude`), which the next step needs.
// 2. The plugins .claude/settings.json turns on (`enabledPlugins`), the Nx plugin among them. The
//    committed setting enables them for everyone, but Claude Code does not download a plugin that
//    only project settings enable: each machine installs it once, with
//    `claude plugin install <id> --scope project`, after adding its marketplace when this machine
//    does not know it yet (`claude plugin marketplace add`, which writes your user settings).
//    A project-scope install rewrites .claude/settings.json: when only the formatting changed,
//    this script puts the file back; any other change is reported for you to review.
// 3. npx on PATH, when the project enables the Nx plugin: its MCP server starts with npx.
// 4. typescript-language-server on PATH: the typescript-lsp plugin starts it.
// 5. Python 3.8+: only the security-guidance opt-in needs it (docs/agents.md).
//
// Plain Node with no dependencies (it may run before `pnpm install`), on macOS, Linux, WSL2 and
// Windows. Exit code: 1 when something it ran failed, or with --check when something remains.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Marketplaces Claude Code knows by name without a settings entry. */
const BUILT_IN_MARKETPLACES = { 'claude-plugins-official': 'anthropics/claude-plugins-official' };
const PLUGIN_ID = /^[\w.-]+@[\w.-]+$/;
const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/;
export const USAGE = `Usage: node tools/setup-agents.mjs [--check]

Once per machine: installs the Claude Code plugins .claude/settings.json enables (project scope),
and checks for npx, typescript-language-server and Python. --check reports without changing anything.`;
export const INSTALL = {
  claude:
    'install Claude Code: https://code.claude.com/docs/en/setup (the desktop app does not put its copy on PATH)',
  npx: 'npx comes with npm: install Node.js with npm, or with proto its npm tool (`proto install npm`), which adds the npm and npx shims',
  tsls: "once, `pnpm setup` (it puts pnpm's global bin directory on PATH; then open a new shell), then `pnpm add -g typescript-language-server typescript`",
  python: 'install Python 3.8 or later (python.org, or your package manager)',
};

/**
 * Run `cmd` with fixed arguments in `cwd`. No shell, except on Windows, where npm-installed CLIs
 * are .cmd shims; the arguments are plain words checked by the callers (PLUGIN_ID, GITHUB_REPO).
 */
function run(cwd, cmd, args, env) {
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 300_000,
    env: env && { ...process.env, ...env },
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  return { ok: res.status === 0 && !res.error, stdout: res.stdout ?? '', out };
}

/**
 * PATH as your shell and Claude Code see it. proto's node shim puts the Node it runs (and its
 * globals) first on PATH, with npx beside it, so npx resolves inside this script on a machine
 * whose shell has none: under a proto shim, drop the directories under proto's `tools`.
 */
export function shellPath(env = process.env) {
  const path = env.PATH ?? '';
  if (!env.PROTO_SHIM_PATH) return path;
  const tools = join(dirname(dirname(env.PROTO_SHIM_PATH)), 'tools');
  const sep = process.platform === 'win32' ? ';' : ':';
  return path
    .split(sep)
    .filter((dir) => dir !== tools && !dir.startsWith(`${tools}/`) && !dir.startsWith(`${tools}\\`))
    .join(sep);
}

const realpath = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
/** The JSON value `text` holds, or undefined. */
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
/** Whether two JSON values are equal (key order ignored). */
function sameJson(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]))
  );
}

/** The plugin ids `settings` enables, and the GitHub repo of each marketplace it declares. */
export function projectPlugins(settings) {
  const ids = Object.entries(settings?.enabledPlugins ?? {})
    .filter(([, on]) => on === true)
    .map(([id]) => id);
  const sources = { ...BUILT_IN_MARKETPLACES };
  for (const [name, { source } = {}] of Object.entries(settings?.extraKnownMarketplaces ?? {}))
    if (source?.source === 'github' && GITHUB_REPO.test(source.repo ?? ''))
      sources[name] = source.repo;
  return { ids, sources };
}

/** Whether `entries` (`claude plugin list --json`) has `id` installed for the project at `root`. */
export function isInstalled(entries, id, root) {
  return entries.some(
    (e) =>
      e?.id === id &&
      (e.scope === 'user' ||
        e.scope === 'managed' ||
        (typeof e.projectPath === 'string' && realpath(e.projectPath) === realpath(root))),
  );
}

/** Python's version from `python --version` output, as [major, minor], or undefined. */
export function pythonVersion(output) {
  const m = String(output).match(/Python (\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/**
 * Set up (or with `check`, only inspect) the machine for the repo at `root`. Returns what is
 * `inPlace`, what it `changed`, what `remains` for you, `optional` notes, and whether something it
 * ran `failed`.
 */
export function setup({ root = ROOT, check = false } = {}) {
  const inPlace = [];
  const changed = [];
  const remains = [];
  const optional = [];
  let failed = false;
  const ok = (text) => inPlace.push(text);
  const todo = (text) => remains.push(text);
  const did = (text) => changed.push(text);
  const fail = (text) => {
    remains.push(text);
    failed = true;
  };

  // 1. Claude Code
  const version = run(root, 'claude', ['--version']);
  const claude = version.ok;
  if (claude) ok(`claude ${version.out.split('\n')[0]}`);
  else todo(`the claude CLI is not on PATH: ${INSTALL.claude}, then run this again`);

  // 2. The plugins the project enables
  const settingsFile = join(root, '.claude', 'settings.json');
  const settingsText = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : undefined;
  const { ids, sources } = projectPlugins(settingsText && parse(settingsText));
  const valid = ids.filter((id) => PLUGIN_ID.test(id));
  for (const id of ids.filter((i) => !valid.includes(i)))
    todo(`.claude/settings.json enables "${id}", which is no plugin@marketplace id: skipped`);
  if (claude && valid.length) {
    const listed = run(root, 'claude', ['plugin', 'list', '--json']);
    const entries = listed.ok ? (parse(listed.stdout) ?? []) : [];
    if (!listed.ok) todo(`could not list the installed plugins (${listed.out}): installing anyway`);
    const missing = valid.filter((id) => !isInstalled(entries, id, root));
    for (const id of valid.filter((i) => !missing.includes(i))) ok(`plugin ${id} is installed`);
    if (missing.length) {
      const known = run(root, 'claude', ['plugin', 'marketplace', 'list', '--json']);
      const knownNames = new Set((known.ok ? (parse(known.stdout) ?? []) : []).map((m) => m?.name));
      for (const name of new Set(missing.map((id) => id.split('@')[1]))) {
        if (knownNames.has(name)) continue;
        const repo = sources[name];
        const add = ['plugin', 'marketplace', 'add', repo];
        if (!repo) todo(`marketplace ${name} is unknown here and not in .claude/settings.json`);
        else if (check) did(`add marketplace ${name}: claude ${add.join(' ')}`);
        else {
          const res = run(root, 'claude', add);
          if (res.ok) did(`added marketplace ${name} (${repo}) to your user settings`);
          else fail(`could not add marketplace ${name}: claude ${add.join(' ')}\n    ${res.out}`);
        }
      }
      for (const id of missing) {
        const install = ['plugin', 'install', id, '--scope', 'project'];
        if (check) {
          did(`install plugin ${id}: claude ${install.join(' ')}`);
          continue;
        }
        const res = run(root, 'claude', install);
        if (res.ok) did(`installed plugin ${id} (project scope)`);
        else fail(`could not install plugin ${id}: claude ${install.join(' ')}\n    ${res.out}`);
      }
      // A project-scope install writes enabledPlugins into .claude/settings.json, which already has
      // them: undo a rewrite that changed only the formatting, report any other change.
      const after = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : undefined;
      if (!check && settingsText !== undefined && after !== settingsText) {
        if (sameJson(parse(after), parse(settingsText))) {
          writeFileSync(settingsFile, settingsText);
          ok('.claude/settings.json: Claude Code reformatted it; put back as committed');
        } else
          did('.claude/settings.json changed: review it with `git diff .claude/settings.json`');
      }
    }
  } else if (!valid.length) ok('.claude/settings.json enables no plugins');
  else todo(`plugins to install once claude is there: ${valid.join(', ')}`);

  // 3. npx, which starts the Nx plugin's MCP server (`npx nx-mcp@latest`)
  if (valid.some((id) => id.startsWith('nx@'))) {
    const npx = run(root, 'npx', ['--version'], { PATH: shellPath() });
    if (npx.ok) ok(`npx ${npx.out.split('\n')[0]} (the Nx plugin's MCP server)`);
    else todo(`npx is not on PATH; the Nx plugin's MCP server starts with it: ${INSTALL.npx}`);
  }

  // 4. The TypeScript language server (plugin typescript-lsp)
  const tsls = run(root, 'typescript-language-server', ['--version']);
  if (tsls.ok)
    ok(`typescript-language-server ${tsls.out.split('\n')[0]} (the typescript-lsp plugin)`);
  else
    todo(
      `typescript-language-server is not on PATH; the typescript-lsp plugin needs it: ${INSTALL.tsls}`,
    );

  // 5. Python, for the security-guidance opt-in only
  const python = [
    ['python3', ['--version']],
    ['python', ['--version']],
    ['py', ['-3', '--version']],
  ]
    .map(([cmd, args]) => pythonVersion(run(root, cmd, args).out))
    .find((v) => v && (v[0] > 3 || (v[0] === 3 && v[1] >= 8)));
  if (python) ok(`Python ${python.join('.')} (only the security-guidance opt-in needs it)`);
  else
    optional.push(
      `no Python 3.8+ on PATH: only the security-guidance opt-in needs it (${INSTALL.python})`,
    );

  return { inPlace, changed, remains, optional, failed };
}

/** A titled list of the report: none when `items` is empty, unless `always`. */
const section = (title, items, always = false) =>
  items.length || always
    ? [`${title}:`, ...(items.length ? items.map((t) => `  - ${t}`) : ['  nothing'])]
    : [];

/** The report of `setup()`, as printed. */
export function report({ inPlace, changed, remains, optional }, { check = false } = {}) {
  return [
    check ? 'setup-agents --check: a report only, nothing was changed' : 'setup-agents:',
    ...section('In place', inPlace),
    ...section(check ? 'Would change' : 'Changed', changed, !check),
    ...section('Remains for you', remains, true),
    ...section('Optional', optional),
    '',
    'Plugins load in the next Claude Code session started at the repo root, after you trust the folder (docs/agents.md).',
  ].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) console.log(USAGE);
  else if (args.some((a) => a !== '--check')) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    const check = args.includes('--check');
    const result = setup({ check });
    console.log(report(result, { check }));
    process.exitCode =
      result.failed || (check && result.remains.length + result.changed.length) ? 1 : 0;
  }
}
