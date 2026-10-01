import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
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

  it('skips test artifacts, so a test writing a broken source there cannot fail a concurrent lint', async () => {
    expect(
      await eslint.isPathIgnored('apps/web/test-output/generate-routes-x/src/routes/broken.tsx'),
    ).toBe(true);
    expect(await eslint.isPathIgnored('apps/web/src/routes/index.tsx')).toBe(false);
  });

  it("allows packages/ui's own #/ subpath imports (what `shadcn add` writes)", async () => {
    expect(await lintUi("import { Button } from '#/components/button';\n")).toEqual([]);
    // the rule is live here: a self-import through the package name is still an error
    expect(await lintUi("import { Button } from '@acme/ui/components/button';\n")).toEqual([
      '1: @nx/enforce-module-boundaries',
    ]);
  });

  it('lets the e2e specs import shared utilities only, as a browser sees the apps', async () => {
    const lintE2e = async (code) => {
      const filePath = join(REPO, 'apps/web-e2e/src/probe.ts');
      const [result] = await eslint.lintText(code, { filePath });
      return result?.messages.map((m) => `${m.line}: ${m.ruleId}`);
    };
    expect(await lintE2e("import { NOTE_LIMITS } from '@acme/validators/notes';\n")).toEqual([]);
    // scope:web allows packages/ui; type:e2e does not
    expect(await lintE2e("import { Button } from '@acme/ui/components/button';\n")).toEqual([
      '1: @nx/enforce-module-boundaries',
    ]);
  });

  it('extracts GraphQL operations from apps/web and still enforces boundaries there', async () => {
    const config = await eslint.calculateConfigForFile('apps/web/src/x.tsx');
    expect(config.rules['@nx/enforce-module-boundaries']?.[0]).toBe(2);
    expect(config.processor?.meta?.name).toBe('@graphql-eslint/processor');
    // the processor must hand back the TS source next to the operations it extracts
    expect(await lintWeb(`import { db } from '@acme/db';\n${probe('apiVersion')}`)).toEqual([
      '1: @nx/enforce-module-boundaries',
    ]);
  });

  it('gives the cross-file GraphQL rules the documents codegen types (apps/web/codegen.ts)', async () => {
    const config = await eslint.calculateConfigForFile('apps/web/src/x.graphql');
    // a computed path: a literal import of another project's file breaks the boundaries rule
    const { default: codegen } = await import(
      pathToFileURL(join(REPO, 'apps/web/codegen.ts')).href
    );
    const web = `${REPO.split(sep).join('/')}/apps/web/`;
    const rebased = codegen.documents.map((d) =>
      d.startsWith('!') ? `!${web}${d.slice(1)}` : `${web}${d}`,
    );
    expect(config.languageOptions.parserOptions.graphQLConfig.documents).toEqual(rebased);
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
