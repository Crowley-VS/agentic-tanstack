#!/usr/bin/env node
// The Node and pnpm versions are pinned in several places (.prototools, .node-version,
// package.json#packageManager, and every Dockerfile: its `node:<version>` images, its
// `pnpm@<version>` installs, its NODE_VERSION / PNPM_VERSION ARGs). They must agree, or pnpm
// silently downloads a different version (breaking offline Docker installs) and "works on my
// machine" bugs appear. Bump them together; this check fails when they disagree. It also checks
// the catalog packages that must share one version (LOCKSTEP).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Catalog entries (pnpm-workspace.yaml) that must name the same version as the first of their
 * pair, because one depends on, or exactly peers, the other. `@playwright/test` brings its own
 * `playwright`: apart, two playwright-cores need two browser revisions, and the one
 * `playwright install` fetches is not the one Vitest Browser Mode launches. `@tailwindcss/vite`
 * depends on its exact `tailwindcss`: apart, the plugin compiles with one and the theme's
 * `@import 'tailwindcss'` loads the other. Nx plugins (`@nx/*`) are released with `nx` and must
 * match it. `<scope>/*` stands for every catalog entry of that scope. Entries missing from the
 * catalog are skipped.
 */
export const LOCKSTEP = [
  ['@playwright/test', 'playwright'],
  ['vitest', '@vitest/browser-playwright'],
  ['tailwindcss', '@tailwindcss/vite'],
  ['nx', '@nx/*'],
];

/** The default catalog of pnpm-workspace.yaml, as { name: version }. */
export function catalogVersions(root = ROOT) {
  const file = join(root, 'pnpm-workspace.yaml');
  if (!existsSync(file)) return {};
  // a final newline, so the last entry ends like the others
  const text = `${readFileSync(file, 'utf8').replaceAll('\r\n', '\n')}\n`;
  // the block runs over indented lines, blank lines and comment lines (a comment may start at
  // column 0 inside a YAML mapping)
  const block = text.match(/^catalog:\n((?:[ \t]+.*\n|[ \t]*(?:#.*)?\n)*)/m)?.[1] ?? '';
  const entries = block.matchAll(/^[ \t]+(['"]?)([^\s'"#:]+)\1:[ \t]*(['"]?)([^\s'"#]+)\3/gm);
  return Object.fromEntries([...entries].map((m) => [m[2], m[4]]));
}

/** One problem per catalog entry whose version differs from its LOCKSTEP partner's. */
export function lockstepMismatches(catalog, lockstep = LOCKSTEP) {
  const problems = [];
  for (const [lead, follower] of lockstep) {
    if (!(lead in catalog)) continue;
    const names = follower.endsWith('/*')
      ? Object.keys(catalog).filter((name) => name.startsWith(follower.slice(0, -1)))
      : [follower].filter((name) => name in catalog);
    for (const name of names)
      if (catalog[name] !== catalog[lead])
        problems.push(
          `catalog versions disagree: ${lead}=${catalog[lead]}, ${name}=${catalog[name]} (bump both)`,
        );
  }
  return problems;
}

/** `Dockerfile`, `Dockerfile.<x>`, `<x>.Dockerfile`, and the same for `Containerfile`. */
const DOCKERFILE = /^(?:Dockerfile|Containerfile)(?:\..+)?$|\.(?:Dockerfile|Containerfile)$/i;

/**
 * The repository's Dockerfiles, tracked or new (not ignored: no dependency's or worktree's), as
 * paths relative to `root`. Outside a git repository: apps/<name>/ and packages/<name>/ only.
 */
export function dockerfiles(root = ROOT) {
  let candidates;
  try {
    candidates = execFileSync(
      'git',
      ['ls-files', '-co', '--exclude-standard', '-z', '--', '*ockerfile*', '*ontainerfile*'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).split('\0');
  } catch {
    const subdirs = (dir) =>
      existsSync(join(root, dir))
        ? readdirSync(join(root, dir), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => `${dir}/${entry.name}`)
        : [];
    candidates = ['apps', 'packages']
      .flatMap(subdirs)
      .flatMap((dir) => readdirSync(join(root, dir)).map((name) => `${dir}/${name}`));
  }
  return [...new Set(candidates)]
    .filter((file) => DOCKERFILE.test(basename(file)) && existsSync(join(root, file)))
    .toSorted((a, b) => a.localeCompare(b));
}

/**
 * The Node and pnpm versions a Dockerfile pins, as { node: [[line, version]], pnpm: [...] }:
 * `node:<version>` image tags (FROM lines, ARG defaults; the version is the tag up to its variant,
 * `24.21.0` of `node:24.21.0-trixie-slim`), `pnpm@<version>` (npm install -g, corepack), and the
 * NODE_VERSION / PNPM_VERSION ARGs. Comment lines and `${…}` references are skipped.
 */
export function dockerfileVersions(text) {
  const found = { node: [], pnpm: [] };
  const patterns = {
    node: [/(?:^|[\s=/])node:(\d[\w.]*?)(?=[-@\s]|$)/g, /^\s*ARG\s+NODE_VERSION=(\d\S*)/g],
    // not `+`: `pnpm@11.27.1+sha512.…` (corepack) pins 11.27.1, like package.json#packageManager
    pnpm: [/(?:^|[\s=/])pnpm@(\d[\w.-]*)/g, /^\s*ARG\s+PNPM_VERSION=(\d\S*)/g],
  };
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    for (const [tool, regexes] of Object.entries(patterns))
      for (const regex of regexes)
        for (const match of line.matchAll(regex)) found[tool].push([i + 1, match[1]]);
  });
  return found;
}

export function collectVersions(root = ROOT) {
  const found = { node: [], pnpm: [] };
  const read = (p) => readFileSync(join(root, p), 'utf8');

  if (existsSync(join(root, '.prototools'))) {
    const text = read('.prototools');
    const node = text.match(/^node\s*=\s*"([^"]+)"/m)?.[1];
    const pnpm = text.match(/^pnpm\s*=\s*"([^"]+)"/m)?.[1];
    if (node) found.node.push(['.prototools', node]);
    if (pnpm) found.pnpm.push(['.prototools', pnpm]);
  }
  if (existsSync(join(root, '.node-version')))
    found.node.push(['.node-version', read('.node-version').trim()]);
  const pkg = JSON.parse(read('package.json'));
  const pm = pkg.packageManager?.match(/^pnpm@([^+]+)/)?.[1];
  if (pm) found.pnpm.push(['package.json#packageManager', pm]);

  for (const file of dockerfiles(root)) {
    const pins = dockerfileVersions(read(file));
    for (const tool of ['node', 'pnpm'])
      for (const [line, version] of pins[tool]) found[tool].push([`${file}:${line}`, version]);
  }
  return found;
}

export function mismatches(found) {
  const problems = [];
  for (const [tool, entries] of Object.entries(found)) {
    const distinct = new Set(entries.map(([, v]) => v));
    if (distinct.size > 1) {
      problems.push(
        `${tool} versions disagree: ${entries.map(([f, v]) => `${f}=${v}`).join(', ')}`,
      );
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = [...mismatches(collectVersions()), ...lockstepMismatches(catalogVersions())];
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exitCode = 1;
  } else {
    console.log('versions: node and pnpm pins agree, and so do lockstep catalog entries');
  }
}
