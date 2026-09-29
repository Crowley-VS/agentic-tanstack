import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { onTestFinished } from 'vitest';

/**
 * Git reads no global or system config in these tests. A developer's `commit.gpgsign`, signing
 * program, `core.hooksPath` or init template would otherwise make temp-repo commits fail (or wait
 * on a signing prompt) for reasons unrelated to the code. Set on process.env when this module
 * loads, so every git process a test starts inherits it: direct calls, the tools under test, the
 * hook scripts and lefthook.
 */
export const HERMETIC_GIT_ENV = { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' };
Object.assign(process.env, HERMETIC_GIT_ENV);

/** A temp directory that is removed when the current test finishes. Call it inside a test. */
export function tempDir(prefix = 'agentic-tools-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Create a throwaway git repo with the given files ({ 'path': 'contents' }). */
export function makeRepo(files = {}) {
  const root = tempDir();
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  for (const [path, contents] of Object.entries(files)) writeFile(root, path, contents);
  return root;
}

export function writeFile(root, path, contents) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
  return full;
}

export function commitAll(root) {
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'test'], { cwd: root });
}

/** Run a hook script with a JSON (or raw string) payload on stdin. */
export function runHook(script, payload, { cwd, env = {} } = {}) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const res = spawnSync(process.execPath, [script], {
    input,
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: '', ...env },
  });
  return { code: res.status, stderr: res.stderr, stdout: res.stdout };
}
