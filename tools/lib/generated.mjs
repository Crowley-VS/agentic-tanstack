// Reads .agents/generated.json — the single list of generated files — and answers
// "is this path generated, and how do I regenerate it?". Shared by the guard hook,
// the format hook, the pre-commit filter, `pnpm regen`, and `agents.mjs sync`.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** macOS and Windows filesystems are case-insensitive by default: `.Claude/Skills/x` is `.claude/skills/x`. */
export const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

/**
 * @typedef {{ id: string, paths: string[], regen: string, protect?: 'always' | 'tracked', description?: string }} Artifact
 */

/** Load the manifest; returns { artifacts: [] } when it does not exist. */
export function loadManifest(root) {
  const file = join(root, '.agents', 'generated.json');
  if (!existsSync(file)) return { artifacts: [] };
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(data.artifacts)) throw new Error(`${file}: "artifacts" must be an array`);
  for (const a of data.artifacts) {
    if (!a.id || !Array.isArray(a.paths) || typeof a.regen !== 'string') {
      throw new Error(`${file}: every artifact needs "id", "paths" (array) and "regen" (string)`);
    }
    if (a.protect && a.protect !== 'always' && a.protect !== 'tracked') {
      throw new Error(`${file}: artifact "${a.id}" has invalid protect "${a.protect}"`);
    }
  }
  return data;
}

/** Minimal glob → RegExp: supports `**`, `*`, `?`. Paths are POSIX, repo-relative. */
export function globToRegExp(glob, { ignoreCase = false } = {}) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
    }
  }
  return new RegExp(`^${re}$`, ignoreCase ? 'i' : '');
}

/**
 * Resolve symlinks in `p`, even when it does not exist yet (a Write creating a new file or
 * directory): the deepest existing ancestor is resolved and the rest is appended unchanged.
 */
export function realpathDeep(p) {
  const abs = resolve(p);
  const rest = [];
  let current = abs;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return abs;
    rest.unshift(basename(current));
    current = parent;
  }
  try {
    return join(realpathSync.native(current), ...rest);
  } catch {
    return abs;
  }
}

/**
 * Normalize any path (absolute, Windows, relative to cwd) to a POSIX repo-relative path.
 * Both sides are symlink-resolved: `git rev-parse --show-toplevel` returns the physical root,
 * while hook input may use a logical path (a symlinked checkout, macOS's /var → /private/var).
 */
export function toRepoPath(root, filePath, cwd = root) {
  const abs = isAbsolute(filePath) ? filePath : join(cwd, filePath);
  return relative(realpathDeep(root), realpathDeep(abs)).split(sep).join('/').replace(/\\/g, '/');
}

/** Find the artifact a repo-relative path belongs to, if any. */
export function findArtifact(manifest, repoPath, { ignoreCase = CASE_INSENSITIVE_FS } = {}) {
  if (repoPath === '..' || repoPath.startsWith('../') || isAbsolute(repoPath)) return undefined;
  return manifest.artifacts.find((a) =>
    a.paths.some((g) => globToRegExp(g, { ignoreCase }).test(repoPath)),
  );
}

/** True if git tracks the file (used for protect: "tracked", e.g. applied migrations). */
export function isTracked(root, repoPath) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', repoPath], {
      cwd: root,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the repository root that owns `cwd`. Git first, so a linked worktree
 * resolves to itself (CLAUDE_PROJECT_DIR points at the main checkout).
 */
export function repoRoot(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return process.env.CLAUDE_PROJECT_DIR || cwd;
  }
}
