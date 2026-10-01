// The second half of web:build: fail the build when the client bundle (.output/public, what every
// browser downloads) contains server-only code. Start's import protection already fails a client
// build that imports a `*.server.*` file; this checks the result, whatever put it there.
//
//   node scripts/check-client-bundle.mjs [dir]   (default: .output/public)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Names only server code uses: the secret, its header, the API's address, the API client. */
export const MARKERS = ['INTERNAL_API_SECRET', 'x-internal-secret', 'API_HOST', 'callInternalApi'];
/**
 * A server-only module: its file name (`env.server.ts` in a source map or a region comment) or a
 * chunk named after it (`env.server-<hash>.js`).
 */
export const SERVER_MODULE = /[\w-]+\.server(?:\.[cm]?[jt]sx?|-[\w-]+\.[cm]?js)\b/;

/** Every leak under `dir`, as `<file>: <what>`; empty when the bundle is clean. */
export function findLeaks(dir) {
  const leaks = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const file = relative(dir, path);
    if (SERVER_MODULE.test(entry.name)) leaks.push(`${file}: named after a *.server module`);
    const text = readFileSync(path, 'utf8');
    for (const marker of MARKERS) if (text.includes(marker)) leaks.push(`${file}: ${marker}`);
    const module = text.match(SERVER_MODULE)?.[0];
    if (module) leaks.push(`${file}: ${module}`);
  }
  return leaks;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(
    process.argv[2] ?? fileURLToPath(new URL('../.output/public', import.meta.url)),
  );
  if (!existsSync(dir)) {
    console.error(`✗ client bundle check: ${dir} does not exist (run vite build first)`);
    process.exit(1);
  }
  const leaks = findLeaks(dir);
  if (leaks.length) {
    console.error(
      [
        `✗ server-only code in the client bundle (${dir}):`,
        ...leaks.map((leak) => `  ${leak}`),
        'Keep it in *.server.ts modules that only server code (server routes, loaders) imports.',
      ].join('\n'),
    );
    process.exit(1);
  }
  console.log('✓ client bundle check: no server-only code in the client bundle');
}
