#!/usr/bin/env node
// Agent-layer maintenance. One script, several modes:
//
//   sync     copy .agents/skills/* → .claude/skills/* (byte-identical copies, no symlinks), remove
//            the copies of deleted skills, and render generated-file protections from
//            .agents/generated.json into .oxfmtrc.json, .oxlintrc.json, .gitattributes and
//            .claude/settings.json (Edit deny rules); --stage (pre-commit, after formatting) also
//            syncs the INDEX from the staged sources, so a commit never carries copies of unstaged
//            or untracked files
//   check    fail if sync is stale, on agent-config hygiene problems, when a skill or subagent
//            names a repo path or pnpm script that does not exist, or when a vendored skill differs
//            from its rewritten upstream (tools/vendor-skills.mjs) (CI, `pnpm check`); --staged
//            checks what the next commit contains instead of the working tree (pre-commit)
//   adopt    move skills that tools wrote directly into .claude/skills into .agents/skills
//   regen    run every regen command from .agents/generated.json; --check = fail when regen
//            changes ANY file (generated outputs and the configs sync renders)
//   staged   pre-commit: format + lint the given staged files (skipping generated ones), and
//            re-stage them at once so the jobs after it see the formatted content. oxfmt itself
//            decides which files it formats (like `oxfmt --check` in `pnpm check`)
//   heal     post-commit: after `git commit -- <paths>`, put back in the index what the
//            pre-commit hook changed in the commit (see healIndex); then sync the working tree
//            from its own sources (see healWorkingTree)
//   install-hooks  install the git hooks (lefthook); the root `prepare` script runs it on
//            `pnpm install`. Skipped when CI is set, like lefthook's own postinstall, and in
//            linked worktrees once the hooks exist (they are shared by every worktree)
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeBin } from './lib/bin.mjs';
import { isScript } from './lib/file-types.mjs';
import { findArtifact, loadManifest, toRepoPath } from './lib/generated.mjs';
import {
  MANIFEST as VENDOR_MANIFEST,
  rewriteTexts,
  vendoredSkills,
  vendorProblems,
} from './vendor-skills.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const LIMITS = {
  agentsMdLines: 200,
  agentsMdBytes: 12_000,
  skillDescription: 300,
  projectSkills: 16,
};
const PORTABLE_FRONTMATTER = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
  'when_to_use',
]);
const BASE_IGNORES = {
  oxfmt: ['pnpm-lock.yaml'],
  oxlint: ['**/dist/**', '**/.output/**', '**/coverage/**'],
};
/** Repo paths `sync` reads and writes. */
const SYNC_PATHS = [
  '.agents',
  '.claude/settings.json',
  '.claude/skills',
  '.gitattributes',
  '.oxfmtrc.json',
  '.oxlintrc.json',
];
/** A .claude/skills copy that no source explains and sync cannot fix on its own. */
const NO_SOURCE = 'has no source in .agents/skills';
/** The block of .gitattributes that sync renders from the manifest (the rest is hand-written). */
const ATTR_START = '# agents:generated:start';
const ATTR_END = '# agents:generated:end';

// ---------- helpers ----------
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const git = (root, args, opts = {}) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', ...opts });
const lines0 = (out) => out.split('\0').filter(Boolean);

/**
 * Copy the INDEX version of `paths` (default: every tracked file) into a new temp dir: exactly
 * what the next commit will contain, whatever the working tree has. The caller removes it.
 */
function exportIndex(root, paths = []) {
  const dir = mkdtempSync(join(tmpdir(), 'agents-index-'));
  const files = lines0(git(root, ['ls-files', '-z', '--', ...paths]));
  if (files.length)
    git(root, ['checkout-index', '-z', '--stdin', `--prefix=${dir}/`], { input: files.join('\0') });
  return dir;
}

/** Make the index hold exactly what `dir` has at each written path (a file or a directory). */
function stageFrom(root, dir, written) {
  if (!written.length) return;
  const modes = new Map(
    lines0(git(root, ['ls-files', '-s', '-z', '--', ...SYNC_PATHS])).map((entry) => {
      const [meta, path] = entry.split('\t');
      return [path, meta.split(' ')[0]];
    }),
  );
  const remove = [];
  const add = [];
  for (const p of written) {
    const full = join(dir, p);
    let now = [];
    if (existsSync(full))
      now = lstatSync(full).isDirectory()
        ? listFiles(full).map((f) => `${p}/${f.split(sep).join('/')}`)
        : [p];
    remove.push(...lines0(git(root, ['ls-files', '-z', '--', p])).filter((f) => !now.includes(f)));
    add.push(...now);
  }
  if (remove.length) git(root, ['update-index', '--force-remove', '--', ...remove]);
  for (const f of add) {
    const sha = git(root, ['hash-object', '-w', '--stdin', `--path=${f}`], {
      input: readFileSync(join(dir, f)),
    }).trim();
    // a skill copy keeps its source's mode (e.g. an executable script)
    const mode =
      modes.get(f.replace(/^\.claude\/skills\//, '.agents/skills/')) ?? modes.get(f) ?? '100644';
    git(root, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${f}`]);
  }
}

function listDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .toSorted((a, b) => a.localeCompare(b));
}

function listFiles(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    return d.isDirectory() ? listFiles(p, base) : [relative(base, p)];
  });
}

const unquoted = (value) => value.replace(/^["']|["']$/g, '');

/**
 * Parse the YAML frontmatter keys/values we care about: one-line values, block scalars (`>`, `|`:
 * folded to one line, blank lines included) and block sequences (`key:`, then `- item` lines: an
 * array of the items).
 */
export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out = {};
  const lines = m[1].split(/\r?\n/);
  // the lines after line `i` that hold its value: indented, blank or `item`, up to the next key
  const valueLines = (i, item) => {
    const own = [];
    for (
      let j = i + 1;
      j < lines.length && (/^(?:\s|$)/.test(lines[j]) || item.test(lines[j]));
      j++
    )
      own.push(lines[j]);
    while (own.length && !own.at(-1).trim()) own.pop();
    return own;
  };
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (/^[>|][-+1-9]*$/.test(value)) {
      const own = valueLines(i, /^\s/);
      i += own.length;
      out[key] = unquoted(
        own
          .map((l) => l.trim())
          .filter(Boolean)
          .join(' '),
      );
    } else if (value === '' && /^\s*-(?:\s|$)/.test(lines[i + 1] ?? '')) {
      // a sequence may sit at the key's own indentation
      const own = valueLines(i, /^-(?:\s|$)/);
      i += own.length;
      out[key] = own
        .map((l) => l.match(/^\s*-\s*(.*)$/)?.[1]?.trim())
        .filter(Boolean)
        .map(unquoted);
    } else out[key] = unquoted(value);
  }
  return out;
}

// ---------- desired state (pure) ----------
/** The manifest's globs in commit `rev` ([] when there is no such commit or manifest). */
function manifestGlobsAt(root, rev) {
  try {
    const text = git(root, ['show', `${rev}:.agents/generated.json`], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return (JSON.parse(text).artifacts ?? []).flatMap((a) => a.paths ?? []);
  } catch {
    return [];
  }
}

/** .gitattributes with its managed block (between the markers) listing `globs` as generated. */
export function renderGitattributes(text, globs) {
  const block = [
    ATTR_START,
    ...[...new Set(globs)].map((g) => `${g} linguist-generated=true`),
    ATTR_END,
  ];
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === ATTR_START);
  const end = lines.findIndex((l, i) => i > start && l.trim() === ATTR_END);
  if (start !== -1 && end !== -1)
    return [...lines.slice(0, start), ...block, ...lines.slice(end + 1)].join('\n');
  const kept = text.replace(/\s+$/, '');
  return `${kept ? `${kept}\n\n` : ''}${block.join('\n')}\n`;
}

/**
 * Everything `sync` would write: { files: { path: desired JSON }, texts: { path: desired text },
 * skills }. `previousGlobs`: the manifest globs of the last commit, whose `Edit(/…)` deny rules
 * sync also owns (so removing an artifact from the manifest removes its rule).
 */
export function desiredState(root = ROOT, { previousGlobs = manifestGlobsAt(root, 'HEAD') } = {}) {
  const manifest = loadManifest(root);
  const generatedGlobs = manifest.artifacts.flatMap((a) => a.paths);
  const alwaysGlobs = manifest.artifacts
    .filter((a) => (a.protect ?? 'always') === 'always')
    .flatMap((a) => a.paths);

  const files = {};
  const texts = {};
  const oxfmtPath = join(root, '.oxfmtrc.json');
  if (existsSync(oxfmtPath)) {
    const cfg = readJson(oxfmtPath);
    cfg.ignorePatterns = [...new Set([...BASE_IGNORES.oxfmt, ...generatedGlobs])];
    files[oxfmtPath] = cfg;
  }
  const oxlintPath = join(root, '.oxlintrc.json');
  if (existsSync(oxlintPath)) {
    const cfg = readJson(oxlintPath);
    cfg.ignorePatterns = [...new Set([...BASE_IGNORES.oxlint, ...generatedGlobs])];
    files[oxlintPath] = cfg;
  }
  const settingsPath = join(root, '.claude', 'settings.json');
  if (existsSync(settingsPath)) {
    const cfg = readJson(settingsPath);
    cfg.permissions ??= {};
    // This script owns exactly the `Edit(/<glob>)` deny rules of the manifest's globs (now or in
    // the last commit) and re-derives them on every sync. Every other deny rule, root-anchored
    // (`Edit(/.github/**)`) or absolute (`Edit(//etc/**)`) ones included, is hand-written and kept.
    const owned = new Set([...generatedGlobs, ...previousGlobs].map((g) => `Edit(/${g})`));
    const managed = [...new Set(alwaysGlobs.map((g) => `Edit(/${g})`))].toSorted((a, b) =>
      a.localeCompare(b),
    );
    const handWritten = (cfg.permissions.deny ?? []).filter((r) => !owned.has(r));
    cfg.permissions.deny = [...handWritten, ...managed];
    files[settingsPath] = cfg;
  }
  const attributesPath = join(root, '.gitattributes');
  if (existsSync(attributesPath))
    texts[attributesPath] = renderGitattributes(
      readFileSync(attributesPath, 'utf8'),
      generatedGlobs,
    );

  const skills = listDirs(join(root, '.agents', 'skills'));
  return { files, texts, skills, manifest };
}

// ---------- sync ----------
function sync(root = ROOT, opts = {}) {
  return syncWithWrites(root, opts).problems;
}

/**
 * Whether `.claude/skills/<name>` is in the last commit: a copy an earlier sync made. HEAD, not
 * the index: a copy that is only staged may still be one a tool wrote there (see adopt).
 */
function committedCopy(root, name) {
  try {
    git(root, ['cat-file', '-e', `HEAD:.claude/skills/${name}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pre-commit: sync the working tree from its own sources, and the INDEX from the STAGED sources.
 * The commit then holds copies and configs that match the committed sources, even when a skill
 * source has unstaged edits or is untracked (it is not in the commit, so neither is its copy).
 * Runs AFTER the formatter (lefthook `piped`), which re-stages what it formatted, so a source
 * oxfmt just reformatted is copied as committed.
 */
function syncAndStage(root = ROOT) {
  // Working tree first, then the index: each is synced from its own sources.
  const working = syncWithWrites(root);
  const snapshot = exportIndex(root, SYNC_PATHS);
  try {
    const index = syncWithWrites(snapshot, {
      tracked: (name) => committedCopy(root, name),
      previousGlobs: manifestGlobsAt(root, 'HEAD'),
      oxfmt: nodeBin(root, 'oxfmt'),
    });
    stageFrom(root, snapshot, index.written);
    return [...new Set([...index.problems, ...working.problems])];
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

/**
 * sync, also returning the repo-relative paths it wrote (files and skill directories).
 * `tracked(name)`: whether `.claude/skills/<name>` is a copy an earlier sync made and committed.
 * `oxfmt`: `[command, ...args]` that runs oxfmt (see nodeBin), or undefined to skip formatting.
 */
function syncWithWrites(
  root,
  {
    write = true,
    tracked = (name) => committedCopy(root, name),
    previousGlobs,
    oxfmt = nodeBin(root, 'oxfmt'),
  } = {},
) {
  const problems = [];
  const { files, texts, skills } = desiredState(root, previousGlobs ? { previousGlobs } : {});
  const written = [];
  const writtenPaths = [];
  const record = (path) => {
    problems.push(`${relative(root, path)} is out of date`);
    if (!write) return false;
    writtenPaths.push(relative(root, path).split(sep).join('/'));
    return true;
  };
  for (const [path, desired] of Object.entries(files)) {
    // Compare content, not formatting: oxfmt may lay the JSON out differently.
    const current = existsSync(path) ? readJson(path) : undefined;
    if (JSON.stringify(current) !== JSON.stringify(desired) && record(path)) {
      writeFileSync(path, `${JSON.stringify(desired, null, 2)}\n`);
      written.push(path);
    }
  }
  for (const [path, desired] of Object.entries(texts)) {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    if (current !== desired && record(path)) writeFileSync(path, desired);
  }
  if (written.length && oxfmt) {
    try {
      const [cmd, ...args] = oxfmt;
      execFileSync(cmd, [...args, '--no-error-on-unmatched-pattern', ...written], {
        cwd: root,
        stdio: 'ignore',
      });
    } catch {
      // formatting is cosmetic; the content is already correct
    }
  }

  const src = join(root, '.agents', 'skills');
  const dst = join(root, '.claude', 'skills');
  for (const name of skills) {
    const from = join(src, name);
    const to = join(dst, name);
    const fromFiles = listFiles(from);
    const toFiles = listFiles(to);
    const same =
      existsSync(to) &&
      !lstatSync(to).isSymbolicLink() &&
      fromFiles.length === toFiles.length &&
      fromFiles.every(
        (f) =>
          existsSync(join(to, f)) && readFileSync(join(from, f)).equals(readFileSync(join(to, f))),
      );
    if (!same) {
      problems.push(`.claude/skills/${name} differs from .agents/skills/${name}`);
      if (write) {
        rmSync(to, { recursive: true, force: true });
        mkdirSync(dirname(to), { recursive: true });
        cpSync(from, to, { recursive: true });
        writtenPaths.push(`.claude/skills/${name}`);
      }
    }
  }
  for (const name of listDirs(dst)) {
    if (skills.includes(name)) continue;
    if (tracked(name)) {
      // Synced and committed earlier, and its source is gone: the skill was deleted.
      problems.push(`.claude/skills/${name} is the copy of a deleted skill`);
      if (write) {
        rmSync(join(dst, name), { recursive: true, force: true });
        writtenPaths.push(`.claude/skills/${name}`);
      }
    } else {
      // Never committed (untracked, or only staged): a tool wrote it there. Only a human can say
      // whether to keep it.
      problems.push(
        `.claude/skills/${name} ${NO_SOURCE}: a tool wrote it there. Run \`node tools/agents.mjs adopt\` to keep it, or delete .claude/skills/${name}`,
      );
    }
  }
  return { problems, written: writtenPaths };
}

/**
 * Post-commit. `git commit -- <paths>` runs the pre-commit hook on a TEMPORARY index: what the
 * hook changes there (a formatted source, the re-synced skill copy) reaches the commit, while the
 * real index keeps the old versions, which then show as a staged revert of the commit. Put the
 * committed version back in the index for every file of the commit whose index entry differs from
 * it while the working tree matches it. After any other commit (and every rebase or merge step)
 * the index equals HEAD, so this changes nothing.
 */
function healIndex(root = ROOT) {
  const z = (args) => new Set(lines0(git(root, [...args, '-z'])));
  const inIndex = z(['diff', '--cached', '--name-only', 'HEAD']);
  if (inIndex.size === 0) return [];
  const committed = z(['diff-tree', '--root', '--no-commit-id', '-r', '--name-only', 'HEAD']);
  const differsInTree = z(['diff', '--name-only', 'HEAD']);
  const heal = [...inIndex].filter((f) => committed.has(f) && !differsInTree.has(f));
  if (heal.length) git(root, ['reset', '-q', 'HEAD', '--', ...heal]);
  return heal;
}

/** git operations that commit step by step; a post-commit that edits files would break the next step. */
const SEQUENCES = ['rebase-merge', 'rebase-apply', 'sequencer'];

/**
 * Post-commit, after healIndex: sync the working tree from its own sources. While the pre-commit
 * hook runs, lefthook hides the unstaged changes of partially staged files, so the pre-commit sync
 * copied the STAGED version of a partially staged skill source; lefthook then restores the unstaged
 * edit in the source only. Returns sync's problems, or undefined when a rebase, cherry-pick or
 * revert is committing step by step (its next step needs a clean working tree).
 */
function healWorkingTree(root = ROOT) {
  const inSequence = SEQUENCES.some((d) =>
    existsSync(resolve(root, git(root, ['rev-parse', '--git-path', d]).trim())),
  );
  return inSequence ? undefined : sync(root);
}

// ---------- install-hooks ----------
/** Like lefthook's postinstall: `CI` set and not overridden by `LEFTHOOK`. */
const enabled = (value) => Boolean(value) && value !== '0' && value !== 'false';

/**
 * Install the git hooks (lefthook.yml), which lefthook's own postinstall does not do reliably:
 * pnpm skips it when lefthook was already built into its store (side-effects cache). Never throws:
 * an install must not fail over hooks. Skipped when CI is set (as lefthook's postinstall does),
 * and in linked worktrees once the hooks exist: they live in the git dir that every worktree
 * shares, and would point into this worktree's node_modules (lefthook falls back to the current
 * checkout's when that path is gone). pnpm re-runs `prepare` before later `pnpm <script>` and
 * `pnpm exec` calls (verifyDepsBeforeRun) without CI, so CI=1 on the first install is not enough.
 * Returns what it did.
 */
function installHooks(
  root = ROOT,
  { env = process.env, lefthook = nodeBin(root, 'lefthook') } = {},
) {
  if (enabled(env.CI) && !enabled(env.LEFTHOOK)) return 'skipped (CI is set)';
  if (!lefthook) return 'skipped (lefthook is not installed)';
  let dirs;
  try {
    dirs = git(
      root,
      [
        'rev-parse',
        '--path-format=absolute',
        '--git-dir',
        '--git-common-dir',
        '--git-path',
        'hooks/pre-commit',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .trim()
      .split('\n');
  } catch {
    return 'skipped (not a git repository)';
  }
  // A worktree-first layout (e.g. a bare clone) has no main checkout to install them from.
  if (dirs[0] !== dirs[1] && existsSync(dirs[2]))
    return 'skipped (linked worktree: the shared hooks are already installed)';
  const [cmd, ...args] = lefthook;
  const res = spawnSync(cmd, [...args, 'install'], { cwd: root, encoding: 'utf8' });
  return res.status === 0
    ? 'installed'
    : `failed: ${`${res.stdout ?? ''}${res.stderr ?? ''}`.trim() || res.error?.message || `exit ${res.status}`}`;
}

// ---------- adopt ----------
function adopt(root = ROOT) {
  const dst = join(root, '.claude', 'skills');
  const src = join(root, '.agents', 'skills');
  const adopted = [];
  for (const name of listDirs(dst)) {
    if (!existsSync(join(src, name))) {
      mkdirSync(src, { recursive: true });
      renameSync(join(dst, name), join(src, name));
      adopted.push(name);
    }
  }
  sync(root);
  return adopted;
}

// ---------- check (hygiene) ----------
const GIT_OUTPUT_COMMANDS = ['diff', 'log', 'show', 'whatchanged', 'format-patch'];
const NX_RUNNERS = ['nx', 'pnpm nx', 'pnpm exec nx', 'pnpm dlx nx', 'pnpx nx', 'npx nx'];
// nx subcommands that only read. Every other one runs or writes something: run, run-many,
// affected, exec and the `nx <target> <project>` shorthand run targets (nx:run-commands takes
// --command/--args, and other arguments are forwarded to the tool), --graph=<file> writes a file.
const NX_READ_ONLY = new Set(['show', 'list', 'report']);
// gh commands that read a PR's whole discussion (`gh pr view --comments`, the comments API):
// `node tools/pr-review.mjs info` passes on only what the PR author and the `gh` user wrote.
const GH_DISCUSSION = ['gh pr view', 'gh issue view', 'gh api'];

/**
 * Why a wildcard allow rule auto-approves more than it seems to, or undefined when it does not
 * (or is not a wildcard). `Bash(git log *)` also approves `git log --output=<any file>`, and
 * `Bash(pnpm nx run *)` also approves `pnpm nx run p:t --command="<anything>"`.
 */
export function unsafeAllowRule(rule) {
  const content = String(rule).match(/^Bash\((.*)\)$/s)?.[1];
  if (content === undefined) return undefined;
  const pattern = content.replace(/:\*$/, ' *'); // legacy `cmd:*` = `cmd *`
  const star = pattern.indexOf('*');
  if (star === -1) return undefined;
  // leading `VAR=value` assignments do not change which command runs
  const prefix = pattern.slice(0, star).replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, '');
  // Options between git/pnpm and the subcommand change what runs where: `git -c core.pager=<cmd>`
  // runs any command, `git -C <dir>` / `--no-pager` and `pnpm -w` / `--filter <p>` reach the same
  // subcommands under another spelling (`git --no-pager log --output=<file>`).
  const words = prefix.split(/\s+/);
  const optionAt = (i) => words.length > i && words[i].startsWith('-');
  if (
    (words[0] === 'git' && optionAt(1)) ||
    (words[0] === 'pnpm' && (optionAt(1) || (['exec', 'dlx'].includes(words[1]) && optionAt(2))))
  )
    return `puts options before the ${words[0]} subcommand, which can run any command (git -c core.pager=<cmd>) or reach any subcommand under another spelling (git -C . diff, pnpm -w nx run); allow the plain command instead`;
  // the wildcard can complete the prefix to `command …`, or the prefix already is `command …`
  const covers = (command) => `${command} `.startsWith(prefix) || prefix.startsWith(`${command} `);
  if (GIT_OUTPUT_COMMANDS.some((c) => covers(`git ${c}`)))
    return 'also approves writing any file (git diff/log/show --output=<file>); drop it (read-only git diff/log need no rule)';
  if (covers('gh api'))
    return 'also approves any GitHub API call, writes included (gh api -X POST), and reading the unfiltered PR discussion; allow exact commands instead';
  if (GH_DISCUSSION.some((c) => covers(c)))
    return 'also approves reading the unfiltered PR discussion (gh pr view --comments), which `node tools/pr-review.mjs info` limits to the PR author and your gh user; allow exact commands or `node tools/pr-review.mjs info *` instead';
  for (const runner of NX_RUNNERS) {
    if (!covers(runner)) continue;
    const rest = prefix.startsWith(`${runner} `) ? prefix.slice(runner.length + 1) : '';
    const sub = rest.match(/^(\S+) /)?.[1]; // undefined: the wildcard can still pick the subcommand
    if (sub === undefined || !NX_READ_ONLY.has(sub))
      return 'also approves any shell command (nx:run-commands --command/--args, arguments forwarded to the tool) and writing any file (--graph=<file>); allow exact commands instead, e.g. `Bash(pnpm nx run tools:test)`';
  }
  return undefined;
}

/**
 * The rules of an `allowed-tools` frontmatter value (parseFrontmatter): space- or comma-separated
 * on one line, a flow sequence (`[a, b]`) or the items of a block sequence (an array); a rule's
 * parentheses may hold spaces (`Read Bash(git add *), "Grep"` → Read, Bash(git add *), Grep).
 * @param {string | unknown[]} [value]
 * @returns {string[]}
 */
export function allowedTools(value = '') {
  if (Array.isArray(value)) return value.flatMap((item) => allowedTools(String(item)));
  return value.match(/[^\s,()'"[\]]+(?:\([^)]*\))?/g) ?? [];
}

// ---------- check: what skills name ----------
/** File extensions that make a code token a file name even without a `/` (`index.test.ts`). */
const FILE_EXTENSION = /\.(?:[cm]?[jt]sx?|json|md|sql|graphql|ya?ml|css|html|sh|toml)$/;
/**
 * Code tokens shaped like a path that name something else: git refs and ranges (`origin/main`,
 * `refs/heads/x`, `main...HEAD`), MIME types (`application/json`), ratios and rates (`3/3`,
 * `10/60s`) and product names (`Node.js`).
 */
const NOT_A_PATH = new RegExp(
  [
    String.raw`^(?:origin|upstream|refs)/`,
    String.raw`(?:^|/)(?:[^/]+\.\.[^/]*|\.\.[^/]+)(?:/|$)`,
    String.raw`^(?:application|audio|font|image|message|model|multipart|text|video)/[\w.-]+$`,
    String.raw`^\d+/`,
    String.raw`^[A-Z][a-z\d]*\.js$`,
  ].join('|'),
);
/**
 * pnpm's own commands (`pnpm help -a`) and those it passes to npm (`view`, `version`, `whoami`…):
 * `pnpm <one of these>` is no package.json script. The ones that run a script are SCRIPT_RUNNERS.
 */
const PNPM_COMMANDS = new Set(
  (
    'add approve-builds audit bin c cache cat-file cat-index clean config create dedupe deploy ' +
    'dlx doctor env exec fetch find-hash help i ignored-builds import init install licenses link ' +
    'list ln ls outdated pack patch patch-commit patch-remove prune publish rb rebuild remove rm ' +
    'root rt run runtime self-update server setup stage store unlink up update why ' +
    'access adduser bugs deprecate dist-tag docs edit info login logout owner ping pkg prefix ' +
    'profile repo s se search set-script show star stars team token unpublish unstar v version ' +
    'view whoami'
  ).split(' '),
);
/** pnpm commands that run a root package.json script, and the script they run. */
const SCRIPT_RUNNERS = new Map([
  ['t', 'test'],
  ['test', 'test'],
  ['it', 'test'],
  ['install-test', 'test'],
  ['start', 'start'],
]);

/**
 * The code in a Markdown text (`code`): every line of a fenced block, and every inline code span
 * outside them. Spans are read as CommonMark reads them, within one block (a paragraph, list
 * item, heading or table row; a span may wrap onto its next line): a run of backticks opens one,
 * the next run of the same length closes it (`` `a` `` holds `a`), and a run that nothing closes
 * is text. So a stray backtick changes at most its own block, as it renders; `stray` holds the
 * line of each such run, as the spans around it may be paired wrongly.
 */
export function markdownCode(markdown) {
  const code = [];
  const stray = [];
  const blocks = [{ line: 1, lines: [] }];
  let fence = '';
  markdown.split(/\r?\n/).forEach((line, i) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (fence) {
      if (
        marker?.[0] === fence[0] &&
        marker.length >= fence.length &&
        !line.trim().slice(marker.length)
      ) {
        fence = '';
        blocks.push({ line: i + 2, lines: [] });
      } else code.push(line);
    } else if (marker) fence = marker;
    else {
      // a blank line ends a block; a list item, heading, quote or table row starts one
      if (!line.trim() || /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}(?:\s|$)|>|\|)/.test(line))
        blocks.push({ line: i + 1, lines: [] });
      blocks.at(-1).lines.push(line);
    }
  });
  for (const { line, lines } of blocks) {
    const block = lines.join('\n');
    const runs = [...block.matchAll(/`+/g)];
    for (let i = 0; i < runs.length; i++) {
      const close = runs.findIndex((run, j) => j > i && run[0].length === runs[i][0].length);
      if (close === -1) {
        stray.push(line + block.slice(0, runs[i].index).split('\n').length - 1);
        continue;
      }
      code.push(
        block.slice(runs[i].index + runs[i][0].length, runs[close].index).replace(/\n/g, ' '),
      );
      i = close;
    }
  }
  return { code, stray };
}

/** The code in a Markdown text (markdownCode). */
export const codeOf = (markdown) => markdownCode(markdown).code;

/**
 * The tokens of `code` that name a repo path: a `/` or a file extension, and nothing a path
 * would not hold (quotes, calls, `=`, `:`, `{}`, `@scope/` packages). `<placeholder>`, `*` and
 * `**` stand for parts of it. Left out: absolute, home, `$VAR` and `./`-relative paths, flags,
 * URLs without a scheme (`github.com/x`), none of which names a file of this repo, and NOT_A_PATH.
 */
export function pathTokens(code) {
  return code
    .flatMap((text) => text.split(/\s+/))
    .map((token) => token.replace(/[;,]$/, ''))
    .filter(
      (token) =>
        /^[\w.$*<>/-]+$/.test(token) &&
        !/[<>]/.test(token.replace(/<[\w.-]+>/g, '')) &&
        !/^(?:[/~$-]|\.\.?\/)/.test(token) &&
        !/^[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\//i.test(token) &&
        !NOT_A_PATH.test(token) &&
        (token.includes('/') || FILE_EXTENSION.test(token)),
    );
}

/**
 * The `pnpm <name>` commands in `code`, as [name, kind]: kind `run` (`pnpm run <script>`), `exec`
 * (`pnpm exec <bin>`) or `pnpm` (anything else). `pnpm --filter …` and other options are skipped.
 */
export function pnpmCommands(code) {
  return code.flatMap((text) =>
    [...text.matchAll(/(?:^|[\s;&|(])pnpm\s+([a-z][\w:.-]*)(?:\s+([a-z@][\w:./@-]*))?/g)]
      .map(([, name, next]) =>
        name === 'run' || name === 'exec' ? [next ?? '', name] : [name, 'pnpm'],
      )
      .filter(([name]) => name),
  );
}

/**
 * A path token as a pattern over repo paths: `*` within a segment, `**` across them (`**\/`: none
 * or more directories), `<placeholder>` and `YYYY-MM-DD` for part of one segment. A token whose
 * first segment is a top-level entry is matched from the root; any other (`index.test.ts`,
 * `src/lib`) as the end of a path.
 */
export function pathPattern(token, topLevel) {
  const path = token.replace(/\/$/, '');
  const body = path
    .split(/(\*\*\/|\*\*|\*|<[^>]+>|YYYY-MM-DD)/)
    .map((part) =>
      part === '**/'
        ? '(?:.*/)?'
        : part === '**'
          ? '.*'
          : part === '*' || part.startsWith('<')
            ? '[^/]+'
            : part === 'YYYY-MM-DD'
              ? '\\d{4}-\\d{2}-\\d{2}'
              : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`${topLevel.has(path.split('/')[0]) ? '^' : '(^|/)'}${body}$`);
}

/** Every repo file in `files`, and each directory of one. */
function withDirectories(files) {
  const entries = new Set(files);
  for (const file of files)
    for (let dir = dirname(file); dir !== '.'; dir = dirname(dir)) entries.add(dir);
  return entries;
}

/** The paths git ignores in `gitRoot`, of those given (none when it is no git work tree). */
function ignoredPaths(gitRoot, paths) {
  const checkIgnore = (list) =>
    spawnSync('git', ['check-ignore', '--no-index', '--stdin', '-z'], {
      cwd: gitRoot,
      input: list.join('\0'),
      encoding: 'utf8',
    });
  if (!paths.length) return new Set();
  const res = checkIgnore(paths);
  // 0: some are ignored, 1: none is
  if (res.status === 0 || res.status === 1) return new Set(lines0(res.stdout));
  // one path git cannot check (outside the repo: `apps/../../x`) fails them all: one at a time
  return new Set(
    paths.filter((p) => {
      const one = checkIgnore([p]);
      return one.status === 0 && lines0(one.stdout).includes(p);
    }),
  );
}

/**
 * The tokens a skill file lists in `<!-- agents:unchecked a b -->` comments: paths the check
 * skips (a file the skill's own steps create, a token that is no path), and the names of `pnpm
 * <name>` commands it does not know.
 */
const uncheckedTokens = (markdown) =>
  new Set(
    [...markdown.matchAll(/<!--\s*agents:unchecked\s+([\s\S]*?)-->/g)].flatMap((m) =>
      m[1].trim().split(/\s+/),
    ),
  );

/** The Markdown files under `dir` (a repo path) in `root`, as repo paths. */
const markdownFiles = (root, dir) =>
  listFiles(join(root, ...dir.split('/')))
    .map((f) => `${dir}/${f.split(sep).join('/')}`)
    .filter((f) => f.endsWith('.md'));

/**
 * What the skill files (`.agents/skills/**\/*.md`) and subagent files (`.claude/agents/**\/*.md`)
 * in `root` name that does not exist: repo paths (`files`: the repo's files; undefined skips
 * paths) and `pnpm` commands (root package.json scripts; `pnpm exec <bin>` and a bare `pnpm <bin>`
 * against `<gitRoot>/node_modules/.bin`, once installed). Only code is read: fenced blocks and
 * inline code spans, plus the `${CLAUDE_PROJECT_DIR}/<path>` a subagent's frontmatter hooks run.
 * Three kinds of path are left out: those git ignores (plans, personal settings, build output:
 * whoever follows the file makes them), those a file lists in an `<!-- agents:unchecked <path> …
 * -->` comment (a file its own steps create, such as a tool's temp file), and the paths upstream
 * wrote in a vendored skill (.agents/vendor.json): its examples name upstream's files, and the
 * vendor check pins that text. What this repo writes into a vendored skill, the `with` text of its
 * rewrites, is read like skill markdown instead, and the pnpm commands of a vendored copy are
 * checked like any other. A subagent file git ignores (one a tool generates on this machine) is
 * not checked at all. Each skill a subagent preloads (its frontmatter `skills`) must be one in
 * .agents/skills: Claude Code starts the subagent without a missing one, and says nothing. A
 * plugin's skill (`plugin:skill`) is not checked.
 */
export function skillReferences(root, { files, gitRoot = root }) {
  const agentFiles = markdownFiles(root, '.claude/agents');
  const localAgents = ignoredPaths(gitRoot, agentFiles);
  const skillFiles = [
    ...markdownFiles(root, '.agents/skills'),
    ...agentFiles.filter((f) => !localAgents.has(f)),
  ];
  if (!skillFiles.length) return [];
  const entries = files && [...withDirectories(files)];
  const topLevel = new Set(entries?.map((e) => e.split('/')[0]));
  const exists = (token) => {
    const pattern = pathPattern(token, topLevel);
    return !entries || entries.some((e) => pattern.test(e));
  };
  const pkgPath = join(root, 'package.json');
  const scripts = existsSync(pkgPath) ? (readJson(pkgPath).scripts ?? {}) : {};
  const binDir = join(gitRoot, 'node_modules', '.bin');
  // undefined before `pnpm install`: binaries are not checked then
  const bins = existsSync(binDir)
    ? new Set(readdirSync(binDir).map((b) => b.replace(/\.(?:cmd|ps1)$/i, '')))
    : undefined;
  const isBin = (name) => !bins || bins.has(name);
  const hasScript = (name) => Object.hasOwn(scripts, name);

  const vendored = new Set(vendoredSkills(root));
  const skillNames = new Set(listDirs(join(root, '.agents', 'skills')));
  const missing = []; // [file, token, how to fix it]
  const problems = [];
  /** Note each path token of markdown `text` (from `where`) that names nothing in the repo. */
  const checkPaths = (where, text, code, fix) => {
    const unchecked = uncheckedTokens(text);
    // a subagent's frontmatter hooks run `${CLAUDE_PROJECT_DIR}/<path>`
    const hooks = [...text.matchAll(/\$\{CLAUDE_PROJECT_DIR\}\/([\w./-]+)/g)].map((m) => m[1]);
    for (const token of new Set([...pathTokens(code), ...hooks]))
      if (!unchecked.has(token) && !exists(token)) missing.push([where, token, fix]);
  };
  for (const file of skillFiles) {
    const text = readFileSync(join(root, file), 'utf8');
    const { code, stray } = markdownCode(text);
    const unchecked = uncheckedTokens(text);
    const vendoredSkill = file.startsWith('.agents/skills/') && vendored.has(file.split('/')[2]);
    if (!vendoredSkill) checkPaths(file, text, code, 'Update the file');
    if (file.startsWith('.claude/agents/'))
      for (const name of preloadedSkills(text))
        if (!name.includes(':') && !skillNames.has(name))
          problems.push(
            `${file} preloads skill "${name}" (frontmatter \`skills\`), which .agents/skills does not have: renamed or removed? Claude Code starts the subagent without it, silently. Update the file`,
          );
    for (const [name, kind] of pnpmCommands(code)) {
      if (unchecked.has(name)) continue;
      // `pnpm test` runs the `test` script; `pnpm start` the `start` script, else `node server.js`
      const runs = kind === 'pnpm' && SCRIPT_RUNNERS.get(name);
      if (runs && !hasScript(runs) && !(runs === 'start' && existsSync(join(root, 'server.js'))))
        problems.push(
          `${file} runs \`pnpm ${name}\`, which runs the root package.json script "${runs}": there is none`,
        );
      if (kind === 'run' && !hasScript(name))
        problems.push(
          `${file} runs \`pnpm run ${name}\`: the root package.json has no such script`,
        );
      if (kind === 'exec' && !isBin(name))
        problems.push(`${file} runs \`pnpm exec ${name}\`: node_modules/.bin has no \`${name}\``);
      if (kind === 'pnpm' && !runs && !hasScript(name) && !PNPM_COMMANDS.has(name) && !isBin(name))
        problems.push(
          `${file} runs \`pnpm ${name}\`, which is no root package.json script, pnpm command or installed binary: renamed or removed? Update the file (a command this check does not know: \`<!-- agents:unchecked ${name} -->\`)`,
        );
    }
    for (const line of stray)
      problems.push(
        `${file} has a backtick on line ${line} that nothing closes: a stray backtick in that paragraph pairs its code spans wrongly, so they go unchecked. Close it, or write a literal one as code (\`\` \` \`\`)`,
      );
  }
  for (const { skill, rewrite, text } of rewriteTexts(root))
    checkPaths(
      `${VENDOR_MANIFEST} (skill ${skill}, rewrite ${rewrite})`,
      text,
      codeOf(text),
      'Update the rewrite, then run `node tools/vendor-skills.mjs update`',
    );
  const ignored = ignoredPaths(
    gitRoot,
    missing.map(([, token]) => token),
  );
  for (const [file, token, fix] of missing)
    if (!ignored.has(token))
      problems.push(
        `${file} names \`${token}\`, which is not in the repo: renamed or deleted? ${fix} (a path that starts with a top-level directory is read from the root; a file its own steps create, or a token that is no repo path: \`<!-- agents:unchecked ${token} -->\`)`,
      );
  return [...new Set(problems)];
}

/** The skills a subagent file's frontmatter preloads (`skills`: a list, or names split by commas). */
function preloadedSkills(text) {
  const skills = parseFrontmatter(text)?.skills;
  const names = Array.isArray(skills)
    ? skills
    : typeof skills === 'string'
      ? skills.replace(/^\[|\]$/g, '').split(',')
      : [];
  return names.map((n) => unquoted(String(n).trim())).filter(Boolean);
}

/** `meta.name` of a workflow script (.claude/workflows/*.js), if it declares one. */
function workflowName(text) {
  return text.match(/export const meta\s*=\s*\{[\s\S]*?\bname:\s*(['"`])([^'"`]+)\1/)?.[2];
}

/**
 * Every file on disk git would commit (tracked or new, not ignored), or undefined when `root` has
 * no `.git` (a source archive: nothing tells repo files from local ones there). Any git failure
 * in a work tree (git missing, a `safe.directory` refusal, a broken worktree link) throws: the
 * paths skills name would go unchecked.
 */
function workingFiles(root) {
  if (!existsSync(join(root, '.git'))) return undefined;
  try {
    return lines0(
      git(root, ['ls-files', '-co', '--exclude-standard', '-z'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ).filter((f) => existsSync(join(root, f))); // a tracked file moved away is gone
  } catch (err) {
    const why = String(err.stderr ?? '').trim() || err.message;
    throw new Error(`git cannot list the repo's files, to check the paths skills name: ${why}`, {
      cause: err,
    });
  }
}

/**
 * Agent-config problems of the checkout at `root`. `files`: the repo's files that skills may name
 * (default: the working tree's); `gitRoot`: the git work tree (ignore rules, node_modules) when
 * `root` is a copy of its index (checkStaged).
 */
function check(
  root = ROOT,
  { tracked, previousGlobs, fix = '`pnpm agents:sync`', files, gitRoot = root } = {},
) {
  const problems = sync(root, { write: false, tracked, previousGlobs }).map((p) =>
    p.includes(NO_SOURCE) ? p : `${p} — run ${fix}`,
  );

  // AGENTS.md / CLAUDE.md
  const agentsMd = join(root, 'AGENTS.md');
  if (!existsSync(agentsMd)) problems.push('AGENTS.md is missing');
  else {
    const text = readFileSync(agentsMd, 'utf8');
    const lines = text.split('\n').length;
    if (lines > LIMITS.agentsMdLines)
      problems.push(`AGENTS.md has ${lines} lines (max ${LIMITS.agentsMdLines})`);
    if (Buffer.byteLength(text) > LIMITS.agentsMdBytes)
      problems.push(`AGENTS.md is ${Buffer.byteLength(text)} bytes (max ${LIMITS.agentsMdBytes})`);
  }
  const claudeMd = join(root, 'CLAUDE.md');
  if (!existsSync(claudeMd)) problems.push('CLAUDE.md is missing');
  else if (readFileSync(claudeMd, 'utf8').split('\n')[0].trim() !== '@AGENTS.md')
    problems.push('CLAUDE.md line 1 must be exactly `@AGENTS.md`');

  // Skills
  const skillNames = listDirs(join(root, '.agents', 'skills'));
  if (skillNames.length > LIMITS.projectSkills)
    problems.push(
      `${skillNames.length} project skills (max ${LIMITS.projectSkills}) — skill listings get truncated`,
    );
  for (const name of skillNames) {
    const file = join(root, '.agents', 'skills', name, 'SKILL.md');
    if (!existsSync(file)) {
      problems.push(`.agents/skills/${name}/SKILL.md is missing`);
      continue;
    }
    const fm = parseFrontmatter(readFileSync(file, 'utf8'));
    if (!fm) problems.push(`.agents/skills/${name}/SKILL.md has no frontmatter`);
    else {
      if (fm.name !== name) problems.push(`skill "${name}": frontmatter name is "${fm.name}"`);
      if (!fm.description) problems.push(`skill "${name}": missing description`);
      else if (fm.description.length > LIMITS.skillDescription)
        problems.push(
          `skill "${name}": description is ${fm.description.length} chars (max ${LIMITS.skillDescription})`,
        );
      for (const key of Object.keys(fm))
        if (!PORTABLE_FRONTMATTER.has(key))
          problems.push(`skill "${name}": non-portable frontmatter key "${key}"`);
      // a skill's allowed-tools approve without asking, like settings allow rules, while it runs
      for (const rule of allowedTools(fm['allowed-tools'])) {
        const why = unsafeAllowRule(rule);
        if (why) problems.push(`skill "${name}": allowed-tools approves ${rule}, which ${why}`);
      }
    }
  }
  // Every repo path and pnpm script they name exists: here, uncached, so that renaming a file a
  // skill names fails `pnpm check` and CI at once (a cached test would notice only on a miss).
  problems.push(...skillReferences(root, { files: files ?? workingFiles(root), gitRoot }));
  // Vendored skills are their pinned upstream, rewritten (.agents/vendor.json): checked here,
  // uncached, so a bump that changes a vendored skill's upstream fails `pnpm check` and CI at once.
  problems.push(...vendorProblems(root, { gitRoot }));

  // Claude Code lists a workflow as a skill named after its meta.name: a workflow and a skill with
  // the same name show up once (as the workflow), so the skill never loads.
  const workflowsDir = join(root, '.claude', 'workflows');
  for (const file of listFiles(workflowsDir).filter((f) => /\.[cm]?js$/.test(f))) {
    const name = workflowName(readFileSync(join(workflowsDir, file), 'utf8'));
    if (name && skillNames.includes(name))
      problems.push(
        `.claude/workflows/${file.split(sep).join('/')} is named "${name}", like the skill .agents/skills/${name}: Claude Code lists only the workflow, so the skill never loads; rename the workflow`,
      );
  }

  // Hooks referenced from settings exist
  const settingsPath = join(root, '.claude', 'settings.json');
  if (existsSync(settingsPath)) {
    const settings = readJson(settingsPath);
    for (const groups of Object.values(settings.hooks ?? {})) {
      for (const group of groups) {
        for (const hook of group.hooks ?? []) {
          for (const arg of hook.args ?? []) {
            const m = String(arg).match(/^\$\{CLAUDE_PROJECT_DIR\}\/(.+)$/);
            if (m && !existsSync(join(root, m[1])))
              problems.push(`hook script ${m[1]} does not exist`);
          }
        }
      }
    }
    for (const rule of settings.permissions?.allow ?? []) {
      const why = unsafeAllowRule(rule);
      if (why) problems.push(`.claude/settings.json allows ${rule}, which ${why}`);
    }
  }

  // No machine-specific paths or promotional instructions in agent-facing files
  const agentFiles = [
    'AGENTS.md',
    'CLAUDE.md',
    '.claude/settings.json',
    '.mcp.json',
    ...listFiles(join(root, '.agents', 'skills')).map((f) => `.agents/skills/${f}`),
    ...listFiles(join(root, '.claude', 'agents')).map((f) => `.claude/agents/${f}`),
    // workflow scripts: their template strings are the prompts of every agent they start
    ...listFiles(join(root, '.claude', 'workflows')).map((f) => `.claude/workflows/${f}`),
  ].map((f) => f.split(sep).join('/'));
  for (const f of agentFiles.filter((file) => existsSync(join(root, file)))) {
    const text = readFileSync(join(root, f), 'utf8');
    if (/(?:^|[\s"'`(])(?:\/home\/|\/Users\/|[A-Z]:\\Users\\)/m.test(text))
      problems.push(`${f} contains a machine-specific absolute path`);
    if (/end (?:each|every) (?:response|reply|message) with/i.test(text))
      problems.push(`${f} contains an instruction to append content to every response`);
  }

  // Kit manifest points at real files, and kit-owned content stays stack-neutral
  const kitPath = join(root, '.agents', 'kit.json');
  if (existsSync(kitPath)) {
    const kit = readJson(kitPath);
    for (const f of kit.files ?? [])
      if (!existsSync(join(root, f))) problems.push(`kit.json lists missing file ${f}`);
    problems.push(...kitLeaks(root, kit));
  }
  return problems;
}

/**
 * Kit-owned files and AGENTS.md sections must not mention stack-only files (kit.json
 * `notYetGeneric`) or the package.json scripts that run them: kit-sync would ship them to repos
 * where they do not exist.
 */
function kitLeaks(root, kit) {
  const stackOnly = Object.keys(kit.notYetGeneric ?? {});
  if (stackOnly.length === 0) return [];
  const pkgPath = join(root, 'package.json');
  const scripts = existsSync(pkgPath) ? (readJson(pkgPath).scripts ?? {}) : {};
  const tokens = [
    ...stackOnly,
    ...Object.entries(scripts)
      .filter(([, cmd]) => stackOnly.some((f) => String(cmd).includes(f)))
      .map(([name]) => `pnpm ${name}`),
  ];
  const owned = (kit.files ?? [])
    .filter((f) => existsSync(join(root, f)))
    .map((f) => [f, readFileSync(join(root, f), 'utf8')]);
  for (const [file, names] of Object.entries(kit.sections ?? {})) {
    if (!existsSync(join(root, file))) continue;
    const text = readFileSync(join(root, file), 'utf8');
    for (const name of names) {
      const m = text.match(new RegExp(`<!-- kit:start:${name} -->([\\s\\S]*?)<!-- kit:end -->`));
      if (m) owned.push([`${file} (kit:${name})`, m[1]]);
    }
  }
  const problems = [];
  for (const [where, text] of owned)
    for (const token of tokens) {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`${escaped}(?![\\w:-])`).test(text))
        problems.push(
          `kit-owned ${where} mentions stack-only \`${token}\` (kit.json notYetGeneric); move it to a stack file or section`,
        );
    }
  return problems;
}

/** check, on what the next commit contains (pre-commit): the index, not the working tree. */
function checkStaged(root = ROOT) {
  const snapshot = exportIndex(root);
  try {
    return check(snapshot, {
      tracked: (name) => committedCopy(root, name),
      previousGlobs: manifestGlobsAt(root, 'HEAD'),
      // re-syncs the index from the staged sources (and the working tree from its own)
      fix: '`pnpm agents:sync --stage`',
      // skills may name only files the commit holds (not untracked or deleted-and-staged ones)
      files: lines0(git(root, ['ls-files', '-z'])),
      gitRoot: root,
    }).map((p) => `staged: ${p}`);
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

// ---------- regen ----------
/**
 * Snapshot { path: sha256 } of every git-visible file (tracked or untracked, not ignored). The
 * whole tree, not just manifest paths: regen commands also rewrite derived files the manifest
 * does not list (`pnpm agents:sync` renders .claude/settings.json, .oxfmtrc.json, .oxlintrc.json).
 */
function snapshotTree(root) {
  const res = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  });
  const snap = new Map();
  for (const f of new Set(res.split('\0').filter(Boolean))) {
    const full = join(root, f);
    if (!existsSync(full) || !lstatSync(full).isFile()) continue;
    snap.set(f, createHash('sha256').update(readFileSync(full)).digest('hex'));
  }
  return snap;
}

/** Run every regen command; with checkOnly, report every file that regen changed (= drift). */
function regen(root = ROOT, { checkOnly = false } = {}) {
  const { artifacts } = loadManifest(root);
  const before = checkOnly ? snapshotTree(root) : undefined;
  for (const cmd of new Set(artifacts.map((a) => a.regen))) {
    console.log(`regen: ${cmd}`);
    execSync(cmd, { cwd: root, stdio: 'inherit' });
  }
  if (!before) return [];
  const after = snapshotTree(root);
  const problems = [];
  for (const [f, hash] of after)
    if (before.get(f) !== hash)
      problems.push(`${f} was out of date (regen changed it) — commit the regenerated file`);
  for (const f of before.keys())
    if (!after.has(f)) problems.push(`${f} is stale (regen removed it) — delete it`);
  return problems;
}

// ---------- staged (pre-commit) ----------
function staged(files, root = ROOT) {
  const manifest = loadManifest(root);
  const keep = files.filter(
    (f) => existsSync(join(root, f)) && !findArtifact(manifest, toRepoPath(root, f)),
  );
  if (keep.length === 0) return;
  const tool = (name) => {
    const cmd = nodeBin(root, name);
    if (!cmd) throw new Error(`${name} is not installed: run \`pnpm install\``);
    return cmd;
  };
  // Files with unstaged changes are left to lefthook's `stage_fixed` (under lefthook there are
  // none: it hides the unstaged changes of partially staged files while the hook runs).
  const unstaged = new Set(lines0(git(root, ['diff', '--name-only', '-z', '--', ...keep])));
  // Every staged file goes to oxfmt, which formats the types it supports and skips the rest: the
  // same decision as the edit hook and `oxfmt --check` in `pnpm check`.
  const [oxfmt, ...oxfmtArgs] = tool('oxfmt');
  execFileSync(oxfmt, [...oxfmtArgs, '--no-error-on-unmatched-pattern', ...keep], {
    cwd: root,
    stdio: 'inherit',
  });
  const lintable = keep.filter(isScript);
  if (lintable.length) {
    const [oxlint, ...oxlintArgs] = tool('oxlint');
    execFileSync(oxlint, [...oxlintArgs, '--fix', ...lintable], { cwd: root, stdio: 'inherit' });
  }
  // Re-stage them now: the next pre-commit job copies skills from the INDEX, and lefthook's
  // `stage_fixed` only re-stages after the whole piped run, which would commit a copy of the
  // unformatted source next to the formatted source.
  const restage = keep.filter((f) => !unstaged.has(f));
  if (restage.length) git(root, ['add', '--', ...restage]);
}

// ---------- CLI ----------
function report(problems, okMessage) {
  if (problems.length === 0) {
    console.log(okMessage);
    return;
  }
  for (const p of problems) console.error(`✗ ${p}`);
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...rest] = process.argv.slice(2);
  switch (mode) {
    case 'sync': {
      const problems = rest.includes('--stage') ? syncAndStage() : sync();
      const unresolved = problems.filter((p) => p.includes(NO_SOURCE));
      const updates = problems.length - unresolved.length;
      console.log(updates ? `agents: synced (${updates} updates)` : 'agents: already in sync');
      for (const p of unresolved) console.warn(`! ${p}`);
      break;
    }
    case 'check': {
      let problems;
      try {
        problems = rest.includes('--staged') ? checkStaged() : check();
      } catch (err) {
        problems = [err.message]; // fails closed: what it could not check is no pass
      }
      report(problems, 'agents: config OK');
      break;
    }
    case 'adopt': {
      const adopted = adopt();
      console.log(
        adopted.length ? `agents: adopted ${adopted.join(', ')}` : 'agents: nothing to adopt',
      );
      break;
    }
    case 'regen':
      report(
        regen(ROOT, { checkOnly: rest.includes('--check') }),
        'regen: generated files up to date',
      );
      break;
    case 'staged':
      try {
        staged(rest);
      } catch (err) {
        // a formatter or linter that failed has already printed why
        if (typeof err.status !== 'number') console.error(`✗ staged: ${err.message}`);
        process.exitCode = err.status || 1;
      }
      break;
    case 'heal': {
      const healed = healIndex();
      if (healed.length)
        console.log(`agents: restored the committed ${healed.join(', ')} in the index`);
      const synced = healWorkingTree() ?? [];
      const updates = synced.filter((p) => !p.includes(NO_SOURCE));
      if (updates.length) console.log(`agents: synced the working tree (${updates.join('; ')})`);
      break;
    }
    case 'install-hooks':
      console.log(`agents: git hooks ${installHooks()}`);
      break;
    default:
      console.error(
        'usage: node tools/agents.mjs <sync [--stage]|check [--staged]|adopt|regen [--check]|staged <files...>|heal|install-hooks>',
      );
      process.exitCode = 1;
  }
}

export {
  adopt,
  check,
  checkStaged,
  healIndex,
  healWorkingTree,
  installHooks,
  regen,
  sync,
  syncAndStage,
};
