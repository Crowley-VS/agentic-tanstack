import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const readJson = (f) => JSON.parse(readFileSync(join(REPO, f), 'utf8'));
/** A web source file whose second line is an operation selecting `fields`. */
const probe = (fields) => `// probe\ngraphql(\`query Probe { ${fields} }\`);\n`;

describe('eslint.config.mjs', () => {
  const eslint = new ESLint({ cwd: REPO });
  /** ESLint's findings for `code` as a file in apps/web/src, as `<line>: <rule>`. */
  const lintWeb = async (code) => {
    const [result] = await eslint.lintText(code, { filePath: join(REPO, 'apps/web/src/probe.ts') });
    return result?.messages.map((m) => `${m.line}: ${m.ruleId}`);
  };
  /** The same, as a component file in packages/ui. */
  const lintUi = async (code) => {
    const filePath = join(REPO, 'packages/ui/src/components/probe.tsx');
    const [result] = await eslint.lintText(code, { filePath });
    return result?.messages.map((m) => `${m.line}: ${m.ruleId}`);
  };

  it.each(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'])(
    'enforces module boundaries on .%s files',
    async (ext) => {
      const config = await eslint.calculateConfigForFile(`packages/validators/src/x.${ext}`);
      expect(config.rules['@nx/enforce-module-boundaries']?.[0]).toBe(2); // "error"
    },
  );

  it("allows packages/ui's own #/ subpath imports (what `shadcn add` writes)", async () => {
    expect(await lintUi("import { Button } from '#/components/button';\n")).toEqual([]);
    // the rule is live here: a self-import through the package name is still an error
    expect(await lintUi("import { Button } from '@acme/ui/components/button';\n")).toEqual([
      '1: @nx/enforce-module-boundaries',
    ]);
  });

  it('extracts GraphQL operations from apps/web and still enforces boundaries there', async () => {
    const config = await eslint.calculateConfigForFile('apps/web/src/x.tsx');
    expect(config.rules['@nx/enforce-module-boundaries']?.[0]).toBe(2);
    expect(config.processor?.meta?.name).toBe('@graphql-eslint/processor');
  });

  it('checks the operations in apps/web against the API schema, at the real line', async () => {
    expect(await lintWeb(probe('apiVersion titel'))).toEqual([
      '2: @graphql-eslint/fields-on-correct-type',
    ]);
    expect(await lintWeb(probe('apiVersion'))).toEqual([]);
  });

  it('is re-run when a file it reads changes (those files are inputs of the cached targets)', () => {
    const source = readFileSync(join(REPO, 'eslint.config.mjs'), 'utf8');
    const reads = [...source.matchAll(/new URL\('\.\/([^']+)', import\.meta\.url\)/g)].map(
      (m) => `{workspaceRoot}/${m[1]}`,
    );
    expect(reads).toContain('{workspaceRoot}/.agents/generated.json');
    expect(reads).toContain('{workspaceRoot}/packages/graphql/schema.graphql');
    const eslintInputs = readJson('nx.json').targetDefaults.eslint.inputs;
    // tools:test builds ESLint from the real config (above)
    const testInputs = readJson('tools/package.json').nx.targets.test.inputs;
    for (const file of reads) {
      expect(eslintInputs, `eslint target: ${file}`).toContain(file);
      expect(testInputs, `tools:test: ${file}`).toContain(file);
    }
  });
});
