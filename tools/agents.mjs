#!/usr/bin/env node
// Agent-layer maintenance. One script, several modes:
//
//   sync     copy .agents/skills/* → .claude/skills/* (byte-identical copies, Windows-safe),
//            remove the copies of deleted skills, and render generated-file protections from
//            .agents/generated.json into .oxfmtrc.json, .oxlintrc.json and .claude/settings.json
//            (Edit deny rules); --stage (pre-commit, after formatting) also syncs the INDEX from
//            the staged sources, so a commit never carries copies of unstaged or untracked files
//   check    fail if sync is stale, or on agent-config hygiene problems (CI); --staged checks
//            what the next commit contains instead of the working tree (pre-commit)
//   adopt    move skills that tools wrote directly into .claude/skills into .agents/skills
//   regen    run every regen command from .agents/generated.json; --check = fail when regen
//            changes ANY file (generated outputs and the configs sync renders)
//   staged   pre-commit: format + lint the given staged files, skipping generated ones
import { execFileSync, execSync } from 'node:child_process';
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
import { findArtifact, isTracked, loadManifest, toRepoPath } from './lib/generated.mjs';

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
  '.oxfmtrc.json',
  '.oxlintrc.json',
];
/** A .claude/skills copy that no source explains and sync cannot fix on its own. */
const NO_SOURCE = 'has no source in .agents/skills';
// Commands that look read-only but write files through a flag (`git diff --output=<file>`,
// `git log --output=<file>`): a wildcard allow rule would auto-approve those writes.
const WRITES_THROUGH_FLAGS = /^Bash\(git (?:diff|log|show|whatchanged|format-patch)\b.*\*/;

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

/** Parse the YAML frontmatter keys/values we care about (single-line and folded `>`/`|` values). */
export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let [, key, value] = kv;
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      value = parts.join(' ');
    }
    out[key] = value.replace(/^["']|["']$/g, '');
  }
  return out;
}

// ---------- desired state (pure) ----------
/** Everything `sync` would write, as { path: desired JSON object } plus the skill list. */
export function desiredState(root = ROOT) {
  const manifest = loadManifest(root);
  const generatedGlobs = manifest.artifacts.flatMap((a) => a.paths);
  const alwaysGlobs = manifest.artifacts
    .filter((a) => (a.protect ?? 'always') === 'always')
    .flatMap((a) => a.paths);

  const files = {};
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
    // Convention: root-anchored `Edit(/...)` deny rules are OWNED by this script and re-derived
    // from the manifest on every sync. Hand-written Edit rules use the unanchored form.
    const managed = [...new Set(alwaysGlobs.map((g) => `Edit(/${g})`))].toSorted((a, b) =>
      a.localeCompare(b),
    );
    const handWritten = (cfg.permissions.deny ?? []).filter((r) => !r.startsWith('Edit(/'));
    cfg.permissions.deny = [...handWritten, ...managed];
    files[settingsPath] = cfg;
  }

  const skills = listDirs(join(root, '.agents', 'skills'));
  return { files, skills, manifest };
}

// ---------- sync ----------
function sync(root = ROOT, opts = {}) {
  return syncWithWrites(root, opts).problems;
}

/**
 * Pre-commit: sync the working tree from its own sources, and the INDEX from the STAGED sources.
 * The commit then holds copies and configs that match the committed sources, even when a skill
 * source has unstaged edits or is untracked (it is not in the commit, so neither is its copy).
 * Runs AFTER the formatter (lefthook `piped`), so a source oxfmt just reformatted and re-staged
 * is copied as committed.
 */
function syncAndStage(root = ROOT) {
  // Working tree first: whether a copy without a source is a removed skill depends on it still
  // being tracked, which the index update below may change.
  const working = syncWithWrites(root);
  const snapshot = exportIndex(root, SYNC_PATHS);
  try {
    const index = syncWithWrites(snapshot, {
      tracked: () => true, // everything in the snapshot came from the index
      oxfmt: join(root, 'node_modules', '.bin', 'oxfmt'),
    });
    stageFrom(root, snapshot, index.written);
    return [...new Set([...index.problems, ...working.problems])];
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

/**
 * sync, also returning the repo-relative paths it wrote (files and skill directories).
 * `tracked(name)`: whether `.claude/skills/<name>` is tracked, i.e. a copy an earlier sync made.
 */
function syncWithWrites(
  root,
  {
    write = true,
    tracked = (name) => isTracked(root, `.claude/skills/${name}`),
    oxfmt = join(root, 'node_modules', '.bin', 'oxfmt'),
  } = {},
) {
  const problems = [];
  const { files, skills } = desiredState(root);
  const written = [];
  const writtenPaths = [];
  for (const [path, desired] of Object.entries(files)) {
    // Compare content, not formatting: oxfmt may lay the JSON out differently.
    const current = existsSync(path) ? readJson(path) : undefined;
    if (JSON.stringify(current) !== JSON.stringify(desired)) {
      problems.push(`${relative(root, path)} is out of date`);
      if (write) {
        writeFileSync(path, `${JSON.stringify(desired, null, 2)}\n`);
        written.push(path);
        writtenPaths.push(relative(root, path).split(sep).join('/'));
      }
    }
  }
  if (written.length && existsSync(oxfmt)) {
    try {
      execFileSync(oxfmt, ['--no-error-on-unmatched-pattern', ...written], {
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
      // Synced earlier and its source is gone: the skill was deleted.
      problems.push(`.claude/skills/${name} is the copy of a deleted skill`);
      if (write) {
        rmSync(join(dst, name), { recursive: true, force: true });
        writtenPaths.push(`.claude/skills/${name}`);
      }
    } else {
      // Untracked: a tool wrote it there. Only a human can say whether to keep it.
      problems.push(
        `.claude/skills/${name} ${NO_SOURCE}: a tool wrote it there. Run \`node tools/agents.mjs adopt\` to keep it, or delete .claude/skills/${name}`,
      );
    }
  }
  return { problems, written: writtenPaths };
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
function check(root = ROOT, { tracked } = {}) {
  const problems = sync(root, { write: false, tracked }).map((p) =>
    p.includes(NO_SOURCE) ? p : `${p} — run \`pnpm agents:sync\``,
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
    }
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
    for (const rule of settings.permissions?.allow ?? [])
      if (WRITES_THROUGH_FLAGS.test(rule))
        problems.push(
          `.claude/settings.json allows ${rule}, which also auto-approves writing any file (--output=<file>); drop the rule (read-only git diff/log need none)`,
        );
  }

  // No machine-specific paths or promotional instructions in agent-facing files
  const agentFiles = [
    'AGENTS.md',
    'CLAUDE.md',
    '.claude/settings.json',
    '.mcp.json',
    ...listFiles(join(root, '.agents', 'skills')).map((f) => `.agents/skills/${f}`),
    ...listFiles(join(root, '.claude', 'agents')).map((f) => `.claude/agents/${f}`),
  ].filter((f) => existsSync(join(root, f)));
  for (const f of agentFiles) {
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
    return check(snapshot, { tracked: () => true }).map((p) => `staged: ${p}`);
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
  const bin = (n) => join(root, 'node_modules', '.bin', n);
  execFileSync(bin('oxfmt'), ['--no-error-on-unmatched-pattern', ...keep], {
    cwd: root,
    stdio: 'inherit',
  });
  const lintable = keep.filter((f) => /\.(?:[cm]?[jt]sx?)$/.test(f));
  if (lintable.length)
    execFileSync(bin('oxlint'), ['--fix', ...lintable], { cwd: root, stdio: 'inherit' });
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
    case 'check':
      report(rest.includes('--staged') ? checkStaged() : check(), 'agents: config OK');
      break;
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
      staged(rest);
      break;
    default:
      console.error(
        'usage: node tools/agents.mjs <sync [--stage]|check [--staged]|adopt|regen [--check]|staged <files...>>',
      );
      process.exitCode = 1;
  }
}

export { adopt, check, checkStaged, regen, sync, syncAndStage, isTracked };
