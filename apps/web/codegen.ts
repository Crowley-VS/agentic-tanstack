// GraphQL Codegen: typed documents for the graphql() operations in src, generated into src/gql
// (committed, never edited by hand) from the API's printed schema. Regenerate with
// `pnpm nx run web:codegen`; `pnpm dev` keeps it up to date. Paths are relative to apps/web.
import type { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
  schema: '../../packages/graphql/schema.graphql',
  // Generated files and tests stay out: gql.ts's documents map ships in the client bundle, so a
  // test-only operation would too. eslint.config.mjs (graphQLConfig.documents) uses the same set.
  documents: [
    'src/**/*.{ts,tsx}',
    '!src/gql/**',
    '!src/routeTree.gen.ts',
    '!src/**/*.test.{ts,tsx}',
    '!src/**/*.browser.test.{ts,tsx}',
  ],
  ignoreNoDocuments: true,
  generates: {
    'src/gql/': {
      preset: 'client',
      // results are plain typed objects (no useFragment unmasking); fragments still work
      presetConfig: { fragmentMasking: false },
      // the client preset forwards only some options to its plugins; all of these are honored
      config: {
        // documents are typed strings: execute() posts `document.toString()`, no graphql-js AST
        documentMode: 'string',
        // tsconfig.base.json: verbatimModuleSyntax needs `import type`, erasableSyntaxOnly needs
        // string unions instead of TS enums
        useTypeImports: true,
        enumType: 'string-literal',
        // every custom scalar must be mapped here (codegen fails on an unmapped one)
        strictScalars: true,
        scalars: { DateTime: 'string' },
      },
    },
  },
};

export default config;
