// ESLint runs ONLY what oxlint can't: Nx module boundaries (and, once the
// GraphQL schema exists, @graphql-eslint on operations). Everything else is
// oxlint (`lint` target). Always run through Nx (`pnpm nx run <p>:eslint`):
// the boundaries rule silently skips without Nx's cached project graph.
import { readFileSync } from 'node:fs';
import nx from '@nx/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

const generated = JSON.parse(
  readFileSync(new URL('./.agents/generated.json', import.meta.url), 'utf8'),
);
const generatedIgnores = generated.artifacts.flatMap((a) => a.paths);

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
      ...generatedIgnores,
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts'],
    languageOptions: { parser: tsParser },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: false,
          allow: [],
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
];
