// Run a tool installed in node_modules the same way on every platform. `node_modules/.bin/<name>`
// is a sh script on Linux/macOS but a `.cmd` shim on Windows, which child_process cannot start
// without a shell. The package's own JS entry, run with this Node, works everywhere.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[command, ...args]` that runs the bin `name` (default: the package name) of package `pkg`
 * installed in `root`, or undefined when the package or its bin is missing.
 */
export function nodeBin(root, pkg, name = pkg) {
  const dir = join(root, 'node_modules', pkg);
  try {
    const { bin } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const entry = typeof bin === 'string' ? bin : bin?.[name];
    if (typeof entry !== 'string' || !existsSync(join(dir, entry))) return undefined;
    return [process.execPath, join(dir, entry)];
  } catch {
    return undefined;
  }
}

/** Options that let child_process start `pnpm` on Windows, where it is a `.cmd` shim. */
export const SHELL_ON_WINDOWS = { shell: process.platform === 'win32' };
