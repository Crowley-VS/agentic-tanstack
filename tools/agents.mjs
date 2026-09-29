#!/usr/bin/env node
// Agent-layer maintenance. One script, several modes:
//
//   sync     copy .agents/skills/* → .claude/skills/* (byte-identical copies, Windows-safe),
//            and render generated-file protections from .agents/generated.json into
//            .oxfmtrc.json, .oxlintrc.json and .claude/settings.json (Edit deny rules)
//   check    fail if sync is stale, or on agent-config hygiene problems (CI + pre-commit)
//   adopt    move skills that tools wrote directly into .claude/skills into .agents/skills
//   regen    run every regen command from .agents/generated.json; --check = fail on drift
//   staged   pre-commit: format + lint the given staged files, skipping generated ones
import { execFileSync, execSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
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

// ---------- helpers ----------
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

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
/** Everything `sync` would write, as { path: contents } plus skill copy plan. */
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
    files[oxfmtPath] = `${JSON.stringify(cfg, null, 2)}\n`;
  }
  const oxlintPath = join(root, '.oxlintrc.json');
  if (existsSync(oxlintPath)) {
    const cfg = readJson(oxlintPath);
    cfg.ignorePatterns = [...new Set([...BASE_IGNORES.oxlint, ...generatedGlobs])];
    files[oxlintPath] = `${JSON.stringify(cfg, null, 2)}\n`;
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
    files[settingsPath] = `${JSON.stringify(cfg, null, 2)}\n`;
  }

  const skills = listDirs(join(root, '.agents', 'skills'));
  return { files, skills, manifest };
}

// ---------- sync ----------
function sync(root = ROOT, { write = true } = {}) {
  const problems = [];
  const { files, skills } = desiredState(root);
  for (const [path, contents] of Object.entries(files)) {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (current !== contents) {
      problems.push(`${relative(root, path)} is out of date`);
      if (write) writeFileSync(path, contents);
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
      }
    }
  }
  for (const name of listDirs(dst)) {
    if (!skills.includes(name)) {
      problems.push(
        `.claude/skills/${name} has no source in .agents/skills (run \`node tools/agents.mjs adopt\` to keep it)`,
      );
    }
  }
  return problems;
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
function check(root = ROOT) {
  const problems = sync(root, { write: false }).map((p) => `${p} — run \`pnpm agents:sync\``);

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

  // Kit manifest points at real files
  const kitPath = join(root, '.agents', 'kit.json');
  if (existsSync(kitPath)) {
    const kit = readJson(kitPath);
    for (const f of kit.files ?? [])
      if (!existsSync(join(root, f))) problems.push(`kit.json lists missing file ${f}`);
  }
  return problems;
}

// ---------- regen ----------
function regen(root = ROOT, { checkOnly = false } = {}) {
  const { artifacts } = loadManifest(root);
  const commands = [...new Set(artifacts.map((a) => a.regen))];
  for (const cmd of commands) {
    console.log(`regen: ${cmd}`);
    execSync(cmd, { cwd: root, stdio: 'inherit' });
  }
  if (!checkOnly) return [];
  const paths = artifacts.flatMap((a) => a.paths.map((p) => `:(glob)${p}`));
  if (paths.length === 0) return [];
  const status = execFileSync('git', ['status', '--porcelain', '--', ...paths], {
    cwd: root,
    encoding: 'utf8',
  });
  return status
    .split('\n')
    .filter(Boolean)
    .map((l) => `generated file out of date: ${l.slice(3)} — commit the output of \`pnpm regen\``);
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
      const changed = sync();
      console.log(
        changed.length ? `agents: synced (${changed.length} updates)` : 'agents: already in sync',
      );
      break;
    }
    case 'check':
      report(check(), 'agents: config OK');
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
        'usage: node tools/agents.mjs <sync|check|adopt|regen [--check]|staged <files...>>',
      );
      process.exitCode = 1;
  }
}

export { adopt, check, regen, sync, isTracked };
