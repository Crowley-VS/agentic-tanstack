// The app's Vite config: TanStack Start (SSR, routes, server routes) on Nitro, plus React.
// Tests do NOT use it (vitest.config.ts): nx.json keeps @nx/vitest from loading this file, since
// resolving it runs Start's route generator (and fails from the workspace root). Never add a
// `test:` key here.
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defaultClientConditions, defaultServerConditions, defineConfig } from 'vite';

// Workspace packages export TypeScript source under the `@acme/source` condition (as tsconfig's
// customConditions does for the type checker). Vite needs it per environment: `resolve` covers
// the client, `ssr.resolve` the server (SSR, server routes, server functions).
const source = '@acme/source';

export default defineConfig({
  resolve: { conditions: [source, ...defaultClientConditions] },
  ssr: { resolve: { conditions: [source, ...defaultServerConditions] } },
  // The port comes from PORT (Nitro's plugin reads it first; the Nx targets set it from this
  // checkout's WEB_PORT). Fail instead of silently moving to another port.
  server: { strictPort: true },
  plugins: [
    tanstackStart(),
    nitro({
      rolldownConfig: {
        // 'use client' directives in dependencies: harmless when bundling the server
        onwarn(warning, warn) {
          if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning);
        },
      },
    }),
    viteReact(),
  ],
});
