// The app's stylesheet (src/styles.css) built as `vite build` builds it: Tailwind emits only the
// classes it finds in the files its @source globs match, and a glob that matches the wrong files
// fails silently (unstyled components, or CSS that depends on files web:build does not hash).
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { build, type Plugin } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const workspace = fileURLToPath(new URL('../../..', import.meta.url));

/** The plugin, recording the files its build transform reads (it registers each as watched). */
function recordingReads(plugin: Plugin, reads: Set<string>): Plugin {
  const { transform } = plugin;
  if (!transform || typeof transform === 'function') return plugin;
  const { handler } = transform;
  return {
    ...plugin,
    transform: {
      ...transform,
      handler(code, id, options) {
        const context = new Proxy(this, {
          get(target, key) {
            if (key === 'addWatchFile') return (file: string) => reads.add(file);
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return handler.call(context, code, id, options);
      },
    },
  };
}

describe('src/styles.css', () => {
  let css = '';
  const reads = new Set<string>();

  beforeAll(async () => {
    const output = await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: tailwindcss().map((plugin) => recordingReads(plugin, reads)),
      build: { write: false, rolldownOptions: { input: 'src/styles.css' } },
    });
    const outputs = [output].flat().flatMap((o) => ('output' in o ? o.output : []));
    css = outputs
      .flatMap((o) => (o.type === 'asset' && o.fileName.endsWith('.css') ? [String(o.source)] : []))
      .join('');
  }, 60_000);

  it('has the theme, the @acme/ui component classes and the classes of this app', () => {
    expect(css).toContain('.dark{'); // the dark theme's variables
    expect(css).toContain('.bg-primary{'); // Button (packages/ui)
    expect(css).toContain('.max-w-md{'); // the home page (apps/web only)
  });

  it('reads only files web:build hashes: the src of this app and of @acme/ui, no tests', () => {
    const files = [...reads].map((file) => relative(workspace, file).split(sep).join('/'));
    const sources = files.filter((file) => !file.includes('node_modules/'));
    expect(sources).toContain('apps/web/src/routes/index.tsx');
    expect(sources).toContain('packages/ui/src/components/button.tsx');
    expect(
      sources.filter((f) => !f.startsWith('apps/web/src/') && !f.startsWith('packages/ui/src/')),
    ).toEqual([]);
    // production inputs leave tests out (nx.json), and this file names the classes it expects
    expect(sources.filter((f) => /\.test\.tsx?$/.test(f))).toEqual([]);
  });
});
