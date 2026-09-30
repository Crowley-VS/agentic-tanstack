// Production bundle: one self-contained dist/ (all dependencies inlined), so the image needs no
// node_modules. The committed migrations are copied next to it (../migrations from dist/), where
// @acme/db's MIGRATIONS_DIR resolves once bundled.
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/main.ts', 'src/migrate.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  fixedExtension: true, // .mjs
  dts: false,
  sourcemap: true,
  deps: {
    alwaysBundle: [/.*/],
    // optional native/edge drivers `pg` probes for: not installed, never used
    neverBundle: ['pg-native', 'pg-cloudflare'],
    onlyBundle: false,
  },
  // copies the folder itself into the project: apps/api/migrations
  copy: [{ from: '../../packages/db/migrations', to: '.' }],
});
