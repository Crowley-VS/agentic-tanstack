#!/usr/bin/env node
// Third-party agent skills, vendored: copies of the SKILL.md an installed npm package ships, with
// the changes this repo needs (its commands, its rules) applied by rewrites listed in
// .agents/vendor.json. The copy is reproducible from the pinned package and the manifest, so it
// stays checkable against upstream:
//
//   update   render every vendored skill from the INSTALLED package: apply its rewrites, write
//            .agents/skills/<name>/SKILL.md and the package's license files, and pin the installed
//            version and the upstream file's sha256 in the manifest. After a dependency bump, run
//            it and review the diff; a rewrite that no longer matches fails it (nothing is written)
//   check    fail when a copy differs from its rewritten upstream, the installed package is not
//            the pinned version, or the upstream text is not the pinned one. `node tools/agents.mjs
//            check` runs it (`pnpm check`, CI, the pre-commit hook), offline
//
// .agents/vendor.json:
//   packages.<npm name>: { version, license, from?, via?, licenseFiles?, source?, licenseNote? }
//     `from`: the workspace directory whose node_modules has the package (default: the root);
//     `via`: the dependency chain that leads to it from there when it is no direct dependency
//     (e.g. ["@playwright/test", "playwright"] for playwright-core). `licenseFiles` are copied
//     to .agents/vendor/<package>/, which holds the license notice of every vendored package
//   skills.<name>: { package, file, sha256, rewrites: [...] }
//     `file`: the SKILL.md inside the package. Each rewrite must change the text, so an upstream
//     change it no longer fits fails `update` and `check` instead of slipping through:
//       { "replace": "<text>", "with": "<text>" }               every occurrence
//       { "pattern": "<regexp>", "flags": "m", "with": "$1…" }  every match (always global)
//       { "section": "## Heading", "with": "<markdown>" }       the heading's section, up to the
//                                                                next heading of its level or above
//       { "frontmatter": "<key>", "with": "<value>" }           set a one-line frontmatter key
//     `with` is a string or an array of lines; `why` says why (for the reader).
// Every copy also gets a notice after its frontmatter: where it comes from, its license, and that
// it was changed (Apache-2.0 asks modified files to say so).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeBin } from './lib/bin.mjs';
import { findArtifact, loadManifest } from './lib/generated.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST = '.agents/vendor.json';
const UPDATE = '`node tools/vendor-skills.mjs update`';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const lf = (text) => text.replace(/\r\n/g, '\n');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** The vendor manifest of `root`, or undefined when it has none. */
export function loadVendorManifest(root) {
  const file = join(root, MANIFEST);
  return existsSync(file) ? readJson(file) : undefined;
}

/** The names of the vendored skills (directories of .agents/skills) in `root`. */
export function vendoredSkills(root) {
  return Object.keys(loadVendorManifest(root)?.skills ?? {});
}

// ---------- rewrites (pure) ----------
const joined = (value) => (Array.isArray(value) ? value.join('\n') : String(value ?? ''));

/** A one-line description of a rewrite, for messages. */
function describe(rewrite) {
  const [kind] = ['replace', 'pattern', 'section', 'frontmatter'].filter((k) => k in rewrite);
  const what = String(rewrite[kind] ?? '').split('\n')[0];
  return `${kind ?? '?'} ${JSON.stringify(what.length > 50 ? `${what.slice(0, 50)}…` : what)}`;
}

/**
 * `text` with the section under the exact heading line `heading` replaced by `replacement` (an
 * empty one removes it): up to the next heading of the same or a higher level, outside fenced code.
 * Undefined when there is no such heading.
 */
export function replaceSection(text, heading, replacement) {
  const lines = text.split('\n');
  const level = heading.match(/^#+/)?.[0].length ?? 0;
  let fence = '';
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (fence) {
      if (
        marker?.[0] === fence[0] &&
        marker.length >= fence.length &&
        !line.trim().slice(marker.length)
      )
        fence = '';
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    if (start === -1) {
      if (line.trimEnd() === heading) start = i;
    } else if ((line.match(/^(#{1,6})\s/)?.[1].length ?? 7) <= level) {
      end = i;
      break;
    }
  }
  if (start === -1 || level === 0) return undefined;
  const body = replacement ? [...replacement.replace(/\n+$/, '').split('\n'), ''] : [];
  return [...lines.slice(0, start), ...body, ...lines.slice(end)].join('\n');
}

/** A YAML single-quoted scalar. */
const yamlString = (value) => `'${value.replaceAll("'", "''")}'`;
/** The value of a one-line YAML scalar: plain, single- or double-quoted (no escapes). */
const unquote = (scalar) =>
  /^'.*'$/.test(scalar)
    ? scalar.slice(1, -1).replaceAll("''", "'")
    : /^".*"$/.test(scalar)
      ? scalar.slice(1, -1)
      : scalar;

/** `text` with frontmatter `key` set to `value` (one line); undefined without frontmatter. */
export function setFrontmatter(text, key, value) {
  const m = text.match(/^---\n([\s\S]*?)\n---(\n|$)/);
  if (!m) return undefined;
  const lines = m[1].split('\n');
  const line = `${key}: ${yamlString(value)}`;
  const at = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (at === -1) lines.push(line);
  else {
    let next = at + 1;
    while (next < lines.length && /^\s+\S/.test(lines[next])) next++; // a folded or nested value
    if (next === at + 1 && unquote(lines[at].slice(key.length + 1).trim()) === value) return text;
    lines.splice(at, next - at, line);
  }
  return `---\n${lines.join('\n')}\n---${m[2]}${text.slice(m[0].length)}`;
}

/** Apply one rewrite; undefined when it cannot apply (no such heading or frontmatter). */
function applyOne(text, rewrite) {
  const replacement = joined(rewrite.with);
  if ('replace' in rewrite) return text.replaceAll(rewrite.replace, () => replacement);
  if ('pattern' in rewrite) {
    const flags = [...new Set(`${rewrite.flags ?? ''}g`)].join('');
    return text.replace(new RegExp(rewrite.pattern, flags), replacement);
  }
  if ('section' in rewrite) return replaceSection(text, rewrite.section, replacement);
  if ('frontmatter' in rewrite) return setFrontmatter(text, rewrite.frontmatter, replacement);
  throw new Error(`unknown rewrite ${JSON.stringify(rewrite)}`);
}

/**
 * `text` with `rewrites` applied in order, and a problem for each rewrite that changes nothing
 * (it is skipped): the upstream text it was written for has changed.
 */
export function applyRewrites(text, rewrites = [], where = 'the upstream text') {
  const problems = [];
  let out = lf(text);
  rewrites.forEach((rewrite, i) => {
    let next;
    try {
      next = applyOne(out, rewrite);
    } catch (err) {
      problems.push(`rewrite ${i + 1} of ${where} is invalid: ${err.message}`);
      return;
    }
    if (next === undefined || next === out)
      problems.push(
        `rewrite ${i + 1} (${describe(rewrite)}) changes nothing in ${where}: upstream changed? Fix or drop it in ${MANIFEST}`,
      );
    else out = next;
  });
  return { text: out, problems };
}

/** The notice every vendored copy carries after its frontmatter. */
export function notice(skill, pkg) {
  return (
    `<!-- Vendored from ${skill.package}@${pkg.version} (${skill.file}), ${pkg.license}: ` +
    `.agents/vendor/${skill.package}/. Changed for this repo by the rewrites in ${MANIFEST}. ` +
    `Do not edit this copy: change its rewrites, then run ${UPDATE}. -->`
  );
}

/** `text` with `line` inserted after its frontmatter (or at the top without one). */
function afterFrontmatter(text, line) {
  const m = text.match(/^---\n[\s\S]*?\n---\n/);
  const at = m ? m[0].length : 0;
  return `${text.slice(0, at)}\n${line}\n${text.slice(at)}`;
}

/** The vendored copy of skill `name`: the upstream text, rewritten, with its notice. */
export function renderSkill(upstream, name, skill, pkg) {
  const { text, problems } = applyRewrites(upstream, skill.rewrites, `skill ${name}`);
  return { text: afterFrontmatter(text, notice(skill, pkg)), problems };
}

// ---------- packages ----------
/**
 * The real directory of package `name` as Node would find it from `dir`: in `node_modules`, then
 * upward, up to `top` (inclusive) when given.
 */
function lookup(dir, name, top) {
  for (let at = dir; ; at = dirname(at)) {
    const candidate = join(at, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (at === top || dirname(at) === at) return undefined;
  }
}

/**
 * The installed directory of vendored package `name` (see `from` and `via`), or undefined. The
 * first step stays inside the repo: a package installed above it is not this repo's.
 */
export function findPackage(gitRoot, name, pkg) {
  let dir = join(gitRoot, pkg.from ?? '.');
  [...(pkg.via ?? []), name].forEach((step, i) => {
    dir = dir && lookup(dir, step, i === 0 ? resolve(gitRoot) : undefined);
  });
  return dir;
}

/** Problems with the manifest's shape (each needs its fields, and skills a known package). */
function shapeProblems(manifest) {
  const problems = [];
  const packages = manifest.packages ?? {};
  for (const [name, pkg] of Object.entries(packages))
    for (const key of ['version', 'license'])
      if (typeof pkg[key] !== 'string')
        problems.push(`${MANIFEST}: package ${name} needs "${key}"`);
  for (const [name, skill] of Object.entries(manifest.skills ?? {})) {
    if (!packages[skill.package])
      problems.push(
        `${MANIFEST}: skill ${name} names package "${skill.package}", which is not in "packages"`,
      );
    if (typeof skill.file !== 'string') problems.push(`${MANIFEST}: skill ${name} needs "file"`);
    if (!Array.isArray(skill.rewrites ?? []))
      problems.push(`${MANIFEST}: skill ${name}: "rewrites" must be an array`);
  }
  return problems;
}

/**
 * Everything the vendored files should hold, rendered from the packages installed in `gitRoot`:
 * { files: { repo path: text }, versions: { package: installed version }, hashes: { skill:
 * sha256 }, problems }. `pinned`: also fail when an installed package or upstream file is not the
 * one the manifest pins (check); otherwise render from whatever is installed (update).
 */
export function render(manifest, gitRoot, { pinned = true } = {}) {
  const problems = [];
  const files = {};
  const versions = {};
  const hashes = {};
  const dirs = {};
  for (const [name, pkg] of Object.entries(manifest.packages ?? {})) {
    const dir = findPackage(gitRoot, name, pkg);
    if (!dir) {
      problems.push(
        `vendored package ${name} is not installed (from ${pkg.from ?? 'the root'}${pkg.via?.length ? ` via ${pkg.via.join(' > ')}` : ''}): removed? Drop its skills from ${MANIFEST}, or run \`pnpm install\``,
      );
      continue;
    }
    const installed = readJson(join(dir, 'package.json')).version;
    versions[name] = installed;
    if (pinned && installed !== pkg.version) {
      problems.push(
        `${name} ${installed} is installed, but ${MANIFEST} pins ${pkg.version}: run ${UPDATE} and review the diff of its vendored skills`,
      );
      continue;
    }
    dirs[name] = dir;
    for (const file of pkg.licenseFiles ?? []) {
      const from = join(dir, file);
      if (existsSync(from))
        files[`.agents/vendor/${name}/${file}`] = lf(readFileSync(from, 'utf8'));
      else problems.push(`${name}@${installed} ships no ${file} (licenseFiles in ${MANIFEST})`);
    }
  }
  for (const [name, skill] of Object.entries(manifest.skills ?? {})) {
    const dir = dirs[skill.package];
    if (!dir) continue;
    const pkg = { ...manifest.packages[skill.package], version: versions[skill.package] };
    const from = join(dir, skill.file);
    if (!existsSync(from)) {
      problems.push(
        `${skill.package}@${pkg.version} no longer ships ${skill.file} (skill ${name})`,
      );
      continue;
    }
    const upstream = readFileSync(from, 'utf8');
    hashes[name] = sha256(upstream);
    if (pinned && hashes[name] !== skill.sha256) {
      problems.push(
        `${skill.package}@${pkg.version} ships a ${skill.file} that is not the pinned one (sha256 ${hashes[name]}, ${MANIFEST} pins ${skill.sha256}): a patched or damaged install? Reinstall, or run ${UPDATE}`,
      );
      continue;
    }
    const rendered = renderSkill(upstream, name, skill, pkg);
    problems.push(...rendered.problems);
    files[`.agents/skills/${name}/SKILL.md`] = rendered.text;
  }
  return { files, versions, hashes, problems };
}

/** Problems that need no installed package: shape, license notices, generated-file listing. */
function staticProblems(root, manifest) {
  const problems = shapeProblems(manifest);
  const generated = loadManifest(root);
  for (const name of Object.keys(manifest.skills ?? {})) {
    if (!findArtifact(generated, `.agents/skills/${name}/SKILL.md`, { ignoreCase: false }))
      problems.push(
        `vendored skill ${name} is not in .agents/generated.json: list \`.agents/skills/${name}/**\` under the artifact whose regen is ${UPDATE} (formatters and hand edits must leave the copy alone)`,
      );
  }
  for (const name of Object.keys(manifest.packages ?? {})) {
    const dir = join(root, '.agents', 'vendor', name);
    if (!existsSync(dir) || readdirSync(dir).length === 0)
      problems.push(
        `.agents/vendor/${name}/ holds no license notice for vendored package ${name}: list its license files in "licenseFiles" and run ${UPDATE}, or write one when the package ships none`,
      );
  }
  return problems;
}

/**
 * What is wrong with the vendored skills of `root`: a copy that differs from its rewritten
 * upstream, a package that is not the pinned version, a rewrite that no longer applies. Packages
 * are read from `<gitRoot>/node_modules`; before `pnpm install` only the manifest is checked.
 */
export function vendorProblems(root = ROOT, { gitRoot = root } = {}) {
  const manifest = loadVendorManifest(root);
  if (!manifest) return [];
  const problems = staticProblems(root, manifest);
  if (problems.length || !existsSync(join(gitRoot, 'node_modules'))) return problems;
  const rendered = render(manifest, gitRoot);
  problems.push(...rendered.problems);
  for (const [path, text] of Object.entries(rendered.files)) {
    const full = join(root, path);
    if (!existsSync(full)) problems.push(`${path} is missing: run ${UPDATE}`);
    else if (lf(readFileSync(full, 'utf8')) !== text)
      problems.push(
        `${path} differs from its rewritten upstream (${MANIFEST}): never edit a vendored copy; change its rewrites, then run ${UPDATE}`,
      );
  }
  return problems;
}

/**
 * Render every vendored skill from the installed packages and write the copies, the license files
 * and the pins. Writes nothing when a problem stops any of them. Returns { written, problems }.
 */
export function update(root = ROOT, { gitRoot = root, oxfmt = nodeBin(root, 'oxfmt') } = {}) {
  const manifest = loadVendorManifest(root);
  if (!manifest) return { written: [], problems: [`${MANIFEST} does not exist`] };
  const rendered = render(manifest, gitRoot, { pinned: false });
  const problems = [...shapeProblems(manifest), ...rendered.problems];
  if (problems.length) return { written: [], problems };
  const written = [];
  for (const [path, text] of Object.entries(rendered.files)) {
    const full = join(root, path);
    if (existsSync(full) && readFileSync(full, 'utf8') === text) continue;
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
    written.push(path);
  }
  const before = JSON.stringify(manifest);
  for (const [name, version] of Object.entries(rendered.versions))
    manifest.packages[name].version = version;
  for (const [name, hash] of Object.entries(rendered.hashes)) manifest.skills[name].sha256 = hash;
  if (JSON.stringify(manifest) !== before) {
    writeFileSync(join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    written.push(MANIFEST);
    if (oxfmt) {
      const [cmd, ...args] = oxfmt;
      try {
        execFileSync(cmd, [...args, MANIFEST], { cwd: root, stdio: 'ignore' });
      } catch {
        // formatting is cosmetic; `pnpm format` fixes it
      }
    }
  }
  return { written, problems: [] };
}

// ---------- CLI ----------
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode] = process.argv.slice(2);
  if (mode === 'check') {
    const problems = vendorProblems();
    for (const p of problems) console.error(`✗ ${p}`);
    if (problems.length) process.exitCode = 1;
    else console.log(`vendor: ${vendoredSkills(ROOT).length} vendored skills match their upstream`);
  } else if (mode === 'update') {
    const { written, problems } = update();
    for (const p of problems) console.error(`✗ ${p}`);
    if (problems.length) process.exitCode = 1;
    else if (!written.length) console.log('vendor: already up to date');
    else {
      for (const p of written) console.log(`vendor: wrote ${p}`);
      console.log(
        'vendor: review the diff, then run `pnpm agents:sync` (the .claude/skills copies)',
      );
    }
  } else {
    console.error('usage: node tools/vendor-skills.mjs <check|update>');
    process.exitCode = 1;
  }
}
