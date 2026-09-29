import { resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');

describe('eslint.config.mjs', () => {
  const eslint = new ESLint({ cwd: REPO });

  it.each(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'])(
    'enforces module boundaries on .%s files',
    async (ext) => {
      const config = await eslint.calculateConfigForFile(`packages/validators/src/x.${ext}`);
      expect(config.rules['@nx/enforce-module-boundaries']?.[0]).toBe(2); // "error"
    },
  );
});
