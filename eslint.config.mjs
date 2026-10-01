// ESLint runs ONLY what oxlint can't: Nx module boundaries, and @graphql-eslint on the web app's
// GraphQL operations (checked against the API's printed schema). Everything else is oxlint
// (`lint` target). Always run through Nx (`pnpm nx run <p>:eslint`): the boundaries rule silently
// skips without Nx's cached project graph.
import { readFileSync } from 'node:fs';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import graphql from '@graphql-eslint/eslint-plugin';
import nx from '@nx/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

const generated = JSON.parse(
  readFileSync(new URL('./.agents/generated.json', import.meta.url), 'utf8'),
);
const generatedIgnores = generated.artifacts.flatMap((a) => a.paths);

/** apps/web/src as an absolute glob base (globs take `/`, on Windows too). */
const webSrc = `${import.meta.dirname.split(sep).join('/')}/apps/web/src`;

const FRAMEWORKS = ['react', 'react-dom', '@tanstack/*', 'graphql-yoga', '@pothos/*', 'vite'];

export default [
  ...nx.configs['flat/base'],
  {
    ignores: [
      '**/dist',
      '**/.output',
      '**/out-tsc',
      '**/node_modules',
      '**/coverage',
      // test artifacts (gitignored): tests write throwaway sources there, e.g. a broken route file
      '**/test-output',
      ...generatedIgnores,
    ],
  },
  {
    // Every JS/TS flavor: boundaries must hold for .mjs/.js code too (all of `tools` is .mjs).
    files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    languageOptions: { parser: tsParser },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: false,
          // `#/…` are Node subpath imports (package.json `imports`), which resolve only inside the
          // importing package: the shadcn CLI writes them (packages/ui/components.json aliases).
          allow: ['#/**'],
          depConstraints: [
            // Where code may live (scope)
            { sourceTag: 'scope:web', onlyDependOnLibsWithTags: ['scope:web', 'scope:shared'] },
            {
              sourceTag: 'scope:api',
              onlyDependOnLibsWithTags: ['scope:api', 'scope:server', 'scope:shared'],
            },
            {
              sourceTag: 'scope:server',
              onlyDependOnLibsWithTags: ['scope:server', 'scope:shared'],
            },
            { sourceTag: 'scope:shared', onlyDependOnLibsWithTags: ['scope:shared'] },
            { sourceTag: 'scope:tooling', onlyDependOnLibsWithTags: ['scope:tooling'] },
            // What kind of code it is (type)
            {
              sourceTag: 'type:app',
              onlyDependOnLibsWithTags: ['type:feature', 'type:data', 'type:ui', 'type:util'],
            },
            {
              sourceTag: 'type:feature',
              onlyDependOnLibsWithTags: ['type:feature', 'type:data', 'type:util'],
              bannedExternalImports: FRAMEWORKS,
            },
            {
              sourceTag: 'type:data',
              onlyDependOnLibsWithTags: ['type:data', 'type:util'],
              bannedExternalImports: ['react', 'react-dom', '@tanstack/*', 'vite'],
            },
            { sourceTag: 'type:ui', onlyDependOnLibsWithTags: ['type:ui', 'type:util'] },
            {
              sourceTag: 'type:util',
              onlyDependOnLibsWithTags: ['type:util'],
              bannedExternalImports: [...FRAMEWORKS, 'drizzle-orm', 'drizzle-orm/*', 'pg'],
            },
          ],
        },
      ],
    },
  },
  // GraphQL operations in apps/web: the processor pulls every graphql(`...`) call out of a file as
  // a virtual `<file>/<n>_document.graphql`, which the next block checks against the schema.
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    processor: graphql.processor,
  },
  {
    files: ['apps/web/src/**/*.graphql'],
    languageOptions: {
      parser: graphql.parser,
      parserOptions: {
        graphQLConfig: {
          // absolute: Nx runs ESLint in the project's directory, and graphql-config resolves
          // relative paths against the cwd
          schema: fileURLToPath(new URL('./packages/graphql/schema.graphql', import.meta.url)),
          // the operations codegen types (apps/web/codegen.ts), for the cross-file rules such as
          // unique-operation-name
          documents: [
            `${webSrc}/**/*.{ts,tsx}`,
            `!${webSrc}/gql/**`,
            `!${webSrc}/routeTree.gen.ts`,
            `!${webSrc}/**/*.test.{ts,tsx}`,
            `!${webSrc}/**/*.browser.test.{ts,tsx}`,
          ],
        },
      },
    },
    plugins: { '@graphql-eslint': graphql },
    rules: graphql.configs['flat/operations-recommended'].rules,
  },
];
