import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const readJson = (f) => JSON.parse(readFileSync(join(REPO, f), 'utf8'));

describe('eslint.config.mjs', () => {
  const eslint = new ESLint({ cwd: REPO });

  it.each(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'])(
    'enforces module boundaries on .%s files',
    async (ext) => {
      const config = await eslint.calculateConfigForFile(`packages/validators/src/x.${ext}`);
      expect(config.rules['@nx/enforce-module-boundaries']?.[0]).toBe(2); // "error"
    },
  );

  it('is re-run when a file it reads changes (those files are inputs of the cached targets)', () => {
    const source = readFileSync(join(REPO, 'eslint.config.mjs'), 'utf8');
    const reads = [...source.matchAll(/new URL\('\.\/([^']+)', import\.meta\.url\)/g)].map(
      (m) => `{workspaceRoot}/${m[1]}`,
    );
    expect(reads).toContain('{workspaceRoot}/.agents/generated.json');
    const eslintInputs = readJson('nx.json').targetDefaults.eslint.inputs;
    // tools:test builds ESLint from the real config (above)
    const testInputs = readJson('tools/package.json').nx.targets.test.inputs;
    for (const file of reads) {
      expect(eslintInputs, `eslint target: ${file}`).toContain(file);
      expect(testInputs, `tools:test: ${file}`).toContain(file);
    }
  });
});
