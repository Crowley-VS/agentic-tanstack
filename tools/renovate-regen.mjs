#!/usr/bin/env node
// The check between the two jobs of .github/workflows/renovate-regen.yml. Its first job runs
// `pnpm regen` on a Renovate branch: the dependency update's own code, with a read-only token. It
// hands over the regenerated files as a patch, and the second job, which can push, stages it and
// runs this before it commits anything. The patch is that untrusted job's output: it may change
// only what `pnpm regen` writes, as plain files. That is the paths of .agents/generated.json (of
// the migrations, only new ones: drizzle-kit generate never changes or deletes a committed one),
// and after a Playwright or drizzle-kit bump the pins in .agents/vendor.json and the license files
// `node tools/vendor-skills.mjs update` writes (as regular files: it never deletes one).
//
//   node tools/renovate-regen.mjs check    exits 1, naming each staged change that is not one
//
// The job stages the patch in the index only (`git apply --cached`): this script, the library it
// imports and the manifest it reads stay the commit's own, whatever the patch holds. Plain Node, no
// dependencies (Node's built-in modules and files of tools/ only): the second job installs none,
// and restores no cache.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { findArtifact, loadManifest } from './lib/generated.mjs';

/** Git modes of a plain file (regular, executable) and of a deleted one. */
const PLAIN = new Set(['100644', '100755', '000000']);
/** The git mode of a path that does not exist: an addition's old mode, a deletion's new one. */
const ABSENT = '000000';
/**
 * The artifacts (.agents/generated.json ids) whose regen command only ever adds files: drizzle-kit
 * generate writes a new migration and never edits or deletes one, and a committed migration may
 * already have run on a database.
 */
export const ADD_ONLY = new Set(['db-migrations']);
/** The vendor manifest, where `vendor-skills update` pins each package's version and skill's sha256. */
export const VENDOR = '.agents/vendor.json';

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** A vendor manifest with its pins (packages' `version`, skills' `sha256`) replaced by their type. */
function withoutPins(manifest) {
  const copy = structuredClone(manifest);
  for (const [key, pin] of [
    ['packages', 'version'],
    ['skills', 'sha256'],
  ])
    for (const entry of isObject(copy[key]) ? Object.values(copy[key]) : [])
      if (isObject(entry)) entry[pin] = typeof entry[pin];
  return copy;
}

/**
 * Whether the change to `path` is one `node tools/vendor-skills.mjs update` (the first regen
 * command) makes outside the generated paths: new pins in .agents/vendor.json, nothing else in it
 * changed, or a license file it copies (a `licenseFiles` entry, to .agents/vendor/<package>/).
 * `{ head, staged }`: the text of .agents/vendor.json at HEAD and in the index (undefined when
 * absent). The change's mode is for problems() to check.
 */
export function isVendorPin(path, { head, staged } = {}) {
  const before = parse(head);
  if (!isObject(before)) return false;
  if (path === VENDOR) {
    const after = parse(staged);
    return isObject(after) && isDeepStrictEqual(withoutPins(before), withoutPins(after));
  }
  return Object.entries(isObject(before.packages) ? before.packages : {}).some(
    ([name, pkg]) =>
      Array.isArray(pkg?.licenseFiles) &&
      pkg.licenseFiles.some((file) => path === `.agents/vendor/${name}/${file}`),
  );
}

/**
 * The staged changes of the repository at `root`, from `git diff --cached --raw -z`: one
 * { oldMode, mode, path } per changed path (renames as a deletion and an addition). `000000` is
 * an absent path: an addition's `oldMode`, a deletion's `mode`.
 */
export function stagedChanges(root) {
  const out = execFileSync('git', ['diff', '--cached', '--raw', '-z', '--no-renames'], {
    cwd: root,
    encoding: 'utf8',
  });
  const fields = out.split('\0');
  const changes = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    // `:<old mode> <new mode> <old sha> <new sha> <status>`, then the path
    const [oldMode, mode] = fields[i].split(' ');
    changes.push({ oldMode: oldMode.replace(/^:/, ''), mode, path: fields[i + 1] });
  }
  return changes;
}

/**
 * One problem per change that `pnpm regen` could not have made: a path it does not write, a link,
 * a change to or the deletion of a committed migration, a vendor file deleted or made executable.
 * `vendor`: `{ head, staged }`, the texts of .agents/vendor.json that isVendorPin compares.
 */
export function problems(changes, manifest, vendor = {}) {
  const found = [];
  for (const { oldMode, mode, path } of changes) {
    const artifact = findArtifact(manifest, path, { ignoreCase: false });
    if (artifact) {
      if (!PLAIN.has(mode)) found.push(`${path}: mode ${mode}, not a plain file`);
      else if (ADD_ONLY.has(artifact.id) && oldMode !== ABSENT)
        found.push(
          `${path}: ${mode === ABSENT ? 'deletes' : 'changes'} a committed file of ${artifact.id} (\`${artifact.regen}\` only adds new ones)`,
        );
    } else if (isVendorPin(path, vendor)) {
      // vendor-skills update writes these as regular files, and never deletes one
      if (mode !== '100644') found.push(`${path}: mode ${mode}, not the regular file it must stay`);
    } else if (path === VENDOR)
      found.push(
        `${path}: changes more than the pins vendor-skills update writes (versions, sha256)`,
      );
    else found.push(`${path}: not a generated file (.agents/generated.json)`);
  }
  return found;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'check') {
    console.error('usage: node tools/renovate-regen.mjs check');
    process.exit(2);
  }
  // the repository the job runs in (its checkout)
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const changes = stagedChanges(root);
  // `git show HEAD:<path>` is the commit's own, `git show :<path>` the staged one
  const show = (rev) => {
    try {
      return execFileSync('git', ['show', `${rev}:${VENDOR}`], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return undefined;
    }
  };
  const found = problems(changes, loadManifest(root), { head: show('HEAD'), staged: show('') });
  if (found.length) {
    for (const p of found) console.error(`✗ ${p}`);
    console.error(
      'renovate-regen: the patch changes more than pnpm regen writes; nothing is pushed',
    );
    process.exitCode = 1;
  } else {
    console.log(`renovate-regen: ${changes.length} regenerated files`);
  }
}
