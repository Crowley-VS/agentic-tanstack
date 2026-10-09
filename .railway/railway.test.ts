// Evaluates railway.ts the way the Railway CLI does (Node type stripping, the CLI's evaluation
// script) and checks the graph it would plan: no login, no network. What only Railway can show
// (the plan, the apply, the deploys) is the manual check in docs/deployment-railway.md.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..');

// The script Railway CLI 5.63.4 runs as `node --experimental-strip-types --input-type=module -e`
// (from the strings of its binary), with one change: its last line is reworded so the SDK does not
// take this for the CLI and run a `railway` binary to check its version.
const EVALUATE = `
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const file = process.argv[1];
const input = JSON.parse(process.env.RAILWAY_IAC_CONTEXT || "{}");
const environment = input.environment ?? input.environmentName ?? undefined;
function fallbackContext(payload) {
  return {
    ...payload,
    ...(environment ? { environment, environmentName: environment } : {}),
    isEnvironment: (name) => environment === name,
    randomString: (label = "random", bytes = 12) =>
      createHash("sha256")
        .update(\`railway-iac:\${environment ?? "default"}:\${label}\`)
        .digest("hex")
        .slice(0, bytes * 2),
    shared: new Proxy({}, {
      get: (_target, name) => {
        if (typeof name !== "string" || name.startsWith("_")) return undefined;
        return { type: "sharedReference", name };
      },
    }),
  };
}
let ctx = fallbackContext(input);
try {
  const iac = await import("railway/iac");
  if (typeof iac.createRailwayContext === "function") {
    ctx = iac.createRailwayContext(input);
  }
} catch {}
const mod = await import(\`\${pathToFileURL(file).href}?t=\${Date.now()}\`);
const partial = mod.partial ?? mod.PARTIAL ?? mod.Partial ?? undefined;
let exported = mod.default ?? mod.main ?? mod.Railway ?? mod;
while (exported && typeof exported === "object" && "default" in exported && exported.name == null && exported.resources == null) {
  exported = exported.default;
}
const projectFactory = (name, definition = {}) => {
  const resources = (definition.resources ?? definition.services ?? []).flat?.() ?? definition.resources ?? [];
  return { name, ...definition, resources };
};
const project = typeof exported === "function" ? await exported(ctx, projectFactory) : exported;
const graph = project && typeof project === "object" && "to_graph" in project ? project.to_graph() : project;
const evaluated = { partial, project: graph };
process.stdout.write(JSON.stringify(evaluated));
`;

type Variable =
  | { type: 'literal'; value: string }
  | { type: 'reference'; resource: string; output: string }
  | { type: 'sharedReference'; name: string };
type Resource = {
  address: string;
  name: string;
  type: string;
  engine?: string;
  image?: string;
  source?: { type: string; repo?: string; branch?: string; checkSuites?: boolean };
  build?: { builder?: string; dockerfilePath?: string; watchPatterns?: string[] };
  deploy?: {
    preDeployCommand?: string[];
    healthcheckPath?: string;
    drainingSeconds?: number;
    startCommand?: string;
  };
  networking?: unknown;
  variables?: Record<string, Variable>;
};

function evaluate(environment: string) {
  const out = execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      '--input-type=module',
      '-e',
      EVALUATE,
      join(HERE, 'railway.ts'),
    ],
    {
      cwd: HERE,
      encoding: 'utf8',
      env: {
        ...process.env,
        RAILWAY_IAC_CONTEXT: JSON.stringify({ command: 'plan', environment }),
      },
    },
  );
  const evaluated: { partial?: string; project: { name: string; resources: Resource[] } } =
    JSON.parse(out);
  return evaluated;
}

const { partial, project } = evaluate('production');
const byAddress = new Map(project.resources.map((r) => [r.address, r]));
const resource = (address: string) => {
  const found = byAddress.get(address);
  if (!found) throw new Error(`railway.ts declares no ${address}`);
  return found;
};
const api = resource('service.api');
const web = resource('service.web');

/** Workspace packages by name → directory (apps/*, packages/*). */
const packageDirs = new Map<string, string>();
for (const group of ['apps', 'packages'])
  for (const dir of readdirSync(join(ROOT, group))) {
    const file = join(ROOT, group, dir, 'package.json');
    if (existsSync(file))
      packageDirs.set(JSON.parse(readFileSync(file, 'utf8')).name, `${group}/${dir}`);
  }

/** The app's directory and every workspace package it depends on, transitively. */
function workspaceClosure(dir: string, seen = new Set<string>()): Set<string> {
  seen.add(dir);
  const pkg = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }))
    if (String(version).startsWith('workspace:')) {
      const depDir = packageDirs.get(name);
      if (depDir && !seen.has(depDir)) workspaceClosure(depDir, seen);
    }
  return seen;
}

/** Railway's watch-path match, for the two pattern shapes railway.ts uses (`/dir/**`, `/file`). */
const watches = (service: Resource, path: string) =>
  (service.build?.watchPatterns ?? []).some((p) =>
    p.endsWith('/**') ? path.startsWith(p.slice(0, -2)) : path === p,
  );

describe('railway.ts', () => {
  it('evaluates under Node type stripping, as the CLI runs it, into one whole-project file', () => {
    expect(partial).toBeUndefined();
    expect(project.name).toBe('acme-app');
    expect([...byAddress.keys()].toSorted()).toEqual([
      'database.Postgres',
      'service.api',
      'service.web',
    ]);
    // the same desired state in every environment (no ctx.environment branches yet)
    expect(evaluate('staging').project).toEqual(project);
  });

  it('runs Postgres 18 from the official Railway image', () => {
    const db = resource('database.Postgres');
    expect(db.engine).toBe('postgres');
    expect(db.image).toBe('ghcr.io/railwayapp-templates/postgres-ssl:18');
  });

  it('builds each app from its Dockerfile in this repository, once CI passes', () => {
    // template.json is the upstream's provenance: bootstrap deletes it and points REPO at the fork
    const templateFile = join(ROOT, 'template.json');
    const template: { repo?: string } = existsSync(templateFile)
      ? JSON.parse(readFileSync(templateFile, 'utf8'))
      : {};
    for (const [service, app] of [
      [api, 'apps/api'],
      [web, 'apps/web'],
    ] as const) {
      expect(service.source).toMatchObject({ type: 'github', branch: 'main', checkSuites: true });
      expect(service.source?.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
      if (template.repo) expect(service.source?.repo).toBe(template.repo);
      expect(service.build).toMatchObject({
        builder: 'DOCKERFILE',
        dockerfilePath: `${app}/Dockerfile`,
      });
      expect(existsSync(join(ROOT, app, 'Dockerfile')), `${app}/Dockerfile`).toBe(true);
      // the image's CMD starts it: one start command for docker run, CI and Railway
      expect(service.deploy?.startCommand).toBeUndefined();
      expect(service.deploy?.drainingSeconds).toBeGreaterThanOrEqual(10);
    }
    expect(api.deploy?.preDeployCommand).toEqual(['node dist/migrate.mjs']);
    expect(api.deploy?.healthcheckPath).toBe('/health');
    expect(web.deploy?.preDeployCommand).toBeUndefined();
    expect(web.deploy?.healthcheckPath).toBe('/api/health');
  });

  it('keeps the api private: no domain or TCP proxy, reached by web over the private network', () => {
    expect(api.networking).toBeUndefined();
    expect(web.variables).toMatchObject({
      API_HOST: { type: 'reference', resource: 'service.api', output: 'RAILWAY_PRIVATE_DOMAIN' },
      API_PORT: { type: 'reference', resource: 'service.api', output: 'PORT' },
    });
    expect(api.variables?.PORT).toMatchObject({ type: 'literal' });
    expect(api.variables?.PORT).toEqual(web.variables?.PORT);
  });

  it('wires the database and one shared secret, never a secret value', () => {
    expect(api.variables?.DATABASE_URL).toEqual({
      type: 'reference',
      resource: 'database.Postgres',
      output: 'DATABASE_URL',
    });
    for (const service of [api, web])
      expect(service.variables?.INTERNAL_API_SECRET).toEqual({
        type: 'sharedReference',
        name: 'INTERNAL_API_SECRET',
      });
    const literals = [api, web].flatMap((s) =>
      Object.entries(s.variables ?? {}).filter(([, v]) => v.type === 'literal'),
    );
    expect(literals.map(([name]) => name)).toEqual(['PORT', 'PORT']);
  });

  it('watches what each image is built from, so a change to one app redeploys only that app', () => {
    const apiDirs = workspaceClosure('apps/api');
    const webDirs = workspaceClosure('apps/web');
    for (const [service, dirs] of [
      [api, apiDirs],
      [web, webDirs],
    ] as const) {
      for (const dir of dirs) expect(service.build?.watchPatterns).toContain(`/${dir}/**`);
      for (const p of service.build?.watchPatterns ?? [])
        expect(p, 'only /dir/** and /file patterns (what `watches` models)').toMatch(
          /^\/[^*]+(\/\*\*)?$/,
        );
      for (const file of ['/package.json', '/pnpm-lock.yaml', '/pnpm-workspace.yaml'])
        expect(watches(service, file)).toBe(true);
    }
    for (const dir of apiDirs)
      if (!webDirs.has(dir)) expect(watches(web, `/${dir}/src/index.ts`), dir).toBe(false);
    for (const dir of webDirs)
      if (!apiDirs.has(dir)) expect(watches(api, `/${dir}/src/index.ts`), dir).toBe(false);
    // what neither image contains redeploys nothing
    for (const file of ['/docs/api.md', '/.railway/railway.ts', '/apps/web-e2e/src/notes.spec.ts'])
      expect([watches(api, file), watches(web, file)], file).toEqual([false, false]);
  });
});
