#!/usr/bin/env node
// The Node and pnpm versions are pinned in several places (.prototools, .node-version,
// package.json#packageManager, the ARGs of apps/*/Dockerfile and packages/*/Dockerfile).
// They must agree, or pnpm silently downloads a different version (breaking offline Docker
// installs) and "works on my machine" bugs appear. Bump them together; this check fails when
// they disagree.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

  for (const dir of ['apps', 'packages']) {
    if (!existsSync(join(root, dir))) continue;
    for (const name of readdirSync(join(root, dir))) {
      const file = join(dir, name, 'Dockerfile');
      if (!existsSync(join(root, file))) continue;
      const text = read(file);
      const node = text.match(/^ARG NODE_VERSION=(\S+)/m)?.[1];
      const pnpm = text.match(/^ARG PNPM_VERSION=(\S+)/m)?.[1];
      if (node) found.node.push([file, node]);
      if (pnpm) found.pnpm.push([file, pnpm]);
    }
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
  const problems = mismatches(collectVersions());
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exitCode = 1;
  } else {
    console.log('versions: node and pnpm pins agree');
  }
}
