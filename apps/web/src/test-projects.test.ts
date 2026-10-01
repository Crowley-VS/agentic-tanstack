// Every test file runs in exactly one of web's Vitest projects (node: vitest.config.ts, Chromium:
// vitest.browser.config.ts). A file that neither includes is typechecked and linted, never run.
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import browser from '../vitest.browser.config';
import node from '../vitest.config';

const root = fileURLToPath(new URL('..', import.meta.url));
const glob = (patterns: readonly string[] = [], exclude: readonly string[] = []) =>
  globSync([...patterns], { cwd: root, exclude: [...exclude] }).toSorted();

it('runs every test file in exactly one project', () => {
  const nodeFiles = glob(node.test?.include, node.test?.exclude);
  const browserFiles = glob(browser.test?.include, browser.test?.exclude);
  expect(nodeFiles.filter((f) => browserFiles.includes(f))).toEqual([]);
  expect([...nodeFiles, ...browserFiles].toSorted()).toEqual(
    glob(['{src,scripts}/**/*.test.*'], ['**/node_modules/**']),
  );
});
