// The production images' Dockerfiles, build context, local stack and CI job, which no single
// project's tests see: what a deploy needs from them (docs/deployment.md). The images themselves
// run in the stack (`pnpm nx run web-e2e:e2e-stack`); these checks need no Docker. tools:test's
// inputs include the Dockerfiles, .dockerignore, the compose files and the workflows, so a change
// to one re-runs them.
import { globSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectVersions } from '../check-versions.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(join(REPO, path), 'utf8');

/** A Dockerfile's instructions (continuation lines joined, comments and blank lines dropped). */
function instructions(path) {
  return read(path)
    .replaceAll(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}
/** The instructions up to the workspace install (the dependency layers). */
function untilInstall(path) {
  const all = instructions(path);
  return all.slice(0, all.findIndex((line) => line.startsWith('RUN pnpm install')) + 1);
}
/** The instructions of the last stage: what the image is. */
function runtime(path) {
  const all = instructions(path);
  return all.slice(all.findLastIndex((line) => line.startsWith('FROM ')));
}
/** The variable names a stage's `ENV` lines set (`ENV A=1 B=2` and `ENV A 1`). */
function envNames(stage) {
  return stage
    .filter((line) => line.startsWith('ENV '))
    .flatMap((line) => {
      const rest = line.slice(4).trim();
      return rest.includes('=')
        ? [...rest.matchAll(/(\S+?)=/g)].map((m) => m[1])
        : [rest.split(/\s/)[0]];
    });
}

/**
 * .dockerignore's rules, in order: Docker's pattern syntax as this file uses it (`**` any number of
 * directories, `*` and `?` within one, a leading `!` re-includes).
 */
function dockerignoreRules(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const negate = line.startsWith('!');
      const pattern = (negate ? line.slice(1) : line).replace(/^\/+/, '');
      let source = '';
      for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '*' && pattern[i + 1] === '*') {
          i++;
          if (pattern[i + 1] === '/') {
            i++;
            source += '(?:.*/)?';
          } else source += '.*';
        } else if (c === '*') source += '[^/]*';
        else if (c === '?') source += '[^/]';
        else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      }
      return { negate, regex: new RegExp(`^${source}$`) };
    });
}
/** Whether Docker leaves `path` out of the build context: the last rule matching it or a parent. */
function ignored(path, rules) {
  const parts = path.split('/');
  const candidates = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  let out = false;
  for (const { negate, regex } of rules)
    if (candidates.some((candidate) => regex.test(candidate))) out = !negate;
  return out;
}

const IMAGES = {
  api: { copies: ['/repo/apps/api/dist ./dist', '/repo/apps/api/migrations ./migrations'] },
  web: { copies: ['/repo/apps/web/.output ./.output'] },
};

const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/, '$2');
/**
 * The services of docker-compose.stack.yml (two-space indents, as written): whether each builds
 * its image, and the ports it publishes.
 */
function stackServices() {
  const text = read('docker-compose.stack.yml');
  const services = {};
  let current;
  let inPorts = false;
  for (const line of text.slice(text.indexOf('\nservices:\n')).split(/\r?\n/)) {
    const name = /^ {2}([\w-]+):\s*$/.exec(line)?.[1];
    if (name) services[name] = current = { build: false, ports: [] };
    if (!current || name) continue;
    if (/^ {4}build:/.test(line)) current.build = true;
    const inline = /^ {4}ports:\s*\[(.*)\]\s*$/.exec(line)?.[1];
    if (inline !== undefined) current.ports.push(...inline.split(',').map(unquote));
    if (/^ {4}\S/.test(line)) inPorts = /^ {4}ports:\s*$/.test(line);
    else if (inPorts && /^ {6}- /.test(line)) current.ports.push(unquote(line.slice(8)));
  }
  return services;
}

/** The `docker` job of .github/workflows/ci.yml, as text: up to the next job or the end. */
function dockerJob() {
  const text = read('.github/workflows/ci.yml');
  const start = text.indexOf('\n  docker:\n');
  expect(start).toBeGreaterThan(0);
  const next = text.slice(start + 1).search(/\n {2}[\w-]+:\n/);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
}

describe('production images', () => {
  it('share the install stage line for line, so the two builds share its cached layers', () => {
    const api = untilInstall('apps/api/Dockerfile');
    expect(api.at(-1)).toBe('RUN pnpm install --offline --frozen-lockfile');
    expect(untilInstall('apps/web/Dockerfile')).toEqual(api);
  });

  for (const [app, { copies }] of Object.entries(IMAGES)) {
    const path = `apps/${app}/Dockerfile`;

    it(`${app}: builds the app alone, without its generators (their output is committed)`, () => {
      expect(instructions(path)).toContain(
        `RUN pnpm nx run ${app}:build --excludeTaskDependencies --outputStyle=static`,
      );
    });

    it(`${app}: no BuildKit cache mount (Railway rejects one without its service id)`, () => {
      expect(read(path)).not.toMatch(/--mount=type=cache/);
    });

    it(`${app}: pins Node in both stages and pnpm, where pnpm check compares them`, () => {
      const { node, pnpm } = collectVersions(REPO);
      expect(node.filter(([file]) => file.startsWith(`${path}:`))).toHaveLength(2);
      expect(pnpm.filter(([file]) => file.startsWith(`${path}:`))).toHaveLength(1);
    });

    it(`${app}: ships only its build output, runs as node, Node as PID 1, a healthcheck`, () => {
      const stage = runtime(path);
      expect(stage.filter((line) => line.startsWith('COPY'))).toEqual(
        copies.map((copy) => `COPY --from=build ${copy}`),
      );
      expect(stage.filter((line) => line.startsWith('RUN'))).toEqual([]);
      const user = stage.findIndex((line) => line === 'USER node');
      expect(user).toBeGreaterThan(0);
      expect(stage.findIndex((line) => line.startsWith('HEALTHCHECK '))).toBeGreaterThan(user);
      // exec form: a shell form CMD would make /bin/sh PID 1, and SIGTERM would not reach Node
      expect(stage.at(-1)).toMatch(/^CMD \["node", /);
      expect(stage).toContain(`ENV NODE_ENV=production PORT=${app === 'api' ? 4000 : 3000}`);
    });

    it(`${app}: sets neither CI nor TEST at runtime (srvx then skips its graceful shutdown)`, () => {
      const names = envNames(runtime(path));
      expect(names).toContain('NODE_ENV');
      expect(names).not.toContain('CI');
      expect(names).not.toContain('TEST');
      // the build stage sets CI: the runtime stage starts from a fresh FROM, never from it
      expect(envNames(instructions(path))).toContain('CI');
    });
  }

  it('api: bakes in its version, by default the commit Railway builds (RAILWAY_GIT_COMMIT_SHA)', () => {
    const stage = runtime('apps/api/Dockerfile');
    const version = [
      'ARG RAILWAY_GIT_COMMIT_SHA',
      'ARG APP_VERSION=${RAILWAY_GIT_COMMIT_SHA:-dev}',
      'ENV APP_VERSION=${APP_VERSION}',
    ].map((line) => stage.indexOf(line));
    expect(version.every((at) => at > 0)).toBe(true);
    // in this order, after the app's files (a new version rebuilds nothing before them), before
    // the switch to the node user; the CMD stays last
    expect(version).toEqual(version.toSorted((a, b) => a - b));
    expect(version[0]).toBeGreaterThan(stage.findLastIndex((line) => line.startsWith('COPY ')));
    expect(version[2]).toBeLessThan(stage.indexOf('USER node'));
    expect(stage.at(-1)).toMatch(/^CMD /);
  });

  it('sends no dependencies, builds, secrets, git data or agent worktrees to the build', () => {
    const lines = read('.dockerignore')
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#'));
    for (const pattern of [
      '**/node_modules',
      '**/dist',
      '**/.output',
      '**/out-tsc', // `pnpm check`'s typecheck writes these: in the context they bust the cache
      '**/tmp',
      '**/.env',
      '**/.env.*',
      '.git',
      '.nx',
      '.claude',
    ])
      expect(lines).toContain(pattern);
    // Nx evaluates every project's configs in the build: eslint.config.mjs reads this file
    expect(lines).not.toContain('.agents');
    expect(lines).toEqual(expect.arrayContaining(['.agents/*', '!.agents/generated.json']));
    expect(read('eslint.config.mjs')).toContain('.agents/generated.json');
    const rules = dockerignoreRules(read('.dockerignore'));
    expect(ignored('.agents/generated.json', rules)).toBe(false);
    expect(ignored('.agents/skills/review-loop/SKILL.md', rules)).toBe(true);
  });

  it("keeps every file the frozen install reads: each workspace package's package.json", () => {
    const workspace = read('pnpm-workspace.yaml');
    const globs = [
      ...(workspace.match(/^packages:\r?\n((?:[ \t]+-.*\r?\n?)+)/m)?.[1] ?? '').matchAll(
        /^[ \t]+-[ \t]*['"]?([^'"\s#]+)/gm,
      ),
    ].map((m) => m[1]);
    expect(globs.length).toBeGreaterThan(0);
    const manifests = globs.flatMap((glob) => globSync(`${glob}/package.json`, { cwd: REPO }));
    expect(manifests).toContain('apps/api/package.json');
    const rules = dockerignoreRules(read('.dockerignore'));
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', ...manifests])
      expect(ignored(file, rules), `${file} is left out of the build context`).toBe(false);
  });

  it('reads .dockerignore patterns the way Docker does', () => {
    const rules = dockerignoreRules(
      '**/node_modules\ndocs\n**/*.md\n.agents/*\n!.agents/keep.json\n',
    );
    expect(ignored('node_modules/x/index.js', rules)).toBe(true);
    expect(ignored('apps/web/node_modules/.bin/vite', rules)).toBe(true);
    expect(ignored('docs/api.md', rules)).toBe(true);
    expect(ignored('apps/api/README.md', rules)).toBe(true);
    expect(ignored('.agents/keep.json', rules)).toBe(false);
    expect(ignored('.agents/skills/a/SKILL.json', rules)).toBe(true);
    expect(ignored('apps/docs/package.json', rules)).toBe(false); // `docs` is the root's only
    expect(ignored('.railway/package.json', dockerignoreRules('.r*\n'))).toBe(true);
  });
});

describe('the local stack (docker-compose.stack.yml)', () => {
  it("runs the dev database's Postgres image, so a version bump moves both", () => {
    const images = (path) => [...read(path).matchAll(/^\s+image:\s*(\S+)/gm)].map((m) => m[1]);
    expect(images('docker-compose.stack.yml')).toEqual(images('docker-compose.yml'));
    expect(images('docker-compose.yml')).toEqual([expect.stringMatching(/^postgres:/)]);
  });

  it('builds the images itself (no `image:` names), so `down --rmi local` removes them', () => {
    const stack = read('docker-compose.stack.yml');
    expect([...stack.matchAll(/^\s+image:/gm)]).toHaveLength(1); // the db's, pulled
    expect(stack).toMatch(/^name: \$\{STACK_PROJECT:-[\w-]+\}$/m);
  });

  it('keeps the API private, as a platform does: only web, and db for the seed, on loopback', () => {
    const services = stackServices();
    expect(Object.keys(services)).toEqual(['db', 'migrate', 'api', 'web']);
    expect(services.api?.ports).toEqual([]); // the e2e 401 check runs from inside the network
    expect(services.migrate?.ports).toEqual([]);
    expect(services.db?.ports).toEqual(['127.0.0.1::5432']); // a port Docker picks
    expect(services.web?.ports).toEqual(['127.0.0.1:${STACK_PORT:-3200}:3000']);
  });

  it('re-runs these checks whenever one of the files they read changes', () => {
    const tools = JSON.parse(read('tools/package.json'));
    expect(tools.nx.targets.test.inputs).toEqual(
      expect.arrayContaining([
        '{workspaceRoot}/**/Dockerfile',
        '{workspaceRoot}/.dockerignore',
        '{workspaceRoot}/docker-compose*.yml',
        '{workspaceRoot}/.github/workflows/*.yml',
      ]),
    );
  });
});

describe("CI's docker job (.github/workflows/ci.yml)", () => {
  it('tags each image it builds with the name compose gives it, so `up --no-build` finds it', () => {
    const job = dockerJob();
    const project = /^ {6}STACK_PROJECT: (\S+)$/m.exec(job)?.[1];
    expect(project).toBeTruthy();
    // COMPOSE_PROJECT_NAME wins over the file's `name:`: the same project either way
    expect(job).toMatch(new RegExp(`^ {6}COMPOSE_PROJECT_NAME: ${project}$`, 'm'));
    const built = Object.entries(stackServices())
      .filter(([, service]) => service.build)
      .map(([name]) => name);
    expect(built).toEqual(['migrate', 'api', 'web']);
    expect(/^ {10}targets: (\S+)$/m.exec(job)?.[1]?.split(',').toSorted()).toEqual(
      built.toSorted(),
    );
    for (const service of built)
      expect(job).toMatch(new RegExp(`^ {12}${service}\\.tags=${project}-${service}$`, 'm'));
  });

  it('builds the commit in as the version, and checks the BFF answers it as apiVersion', () => {
    const job = dockerJob();
    // the build argument Railway gives its builds, so CI tests the Dockerfile's default path
    expect(job).toMatch(/^ {12}\*\.args\.RAILWAY_GIT_COMMIT_SHA=\$\{\{ github\.sha \}\}$/m);
    const start = job.indexOf('- name: The API reports the commit as its version');
    expect(start).toBeGreaterThan(0);
    const end = job.indexOf('\n      - ', start);
    const step = job.slice(start, end < 0 ? undefined : end);
    expect(step).toMatch(/^ {10}SHA: \$\{\{ github\.sha \}\}$/m);
    expect(step).toContain(`--data '{"query":"{ apiVersion }"}'`);
    expect(step).toContain('"http://$(docker compose port web 3000)/api/graphql"');
    expect(step).toContain('[ "$answer" = "{\\"data\\":{\\"apiVersion\\":\\"$SHA\\"}}" ]');
  });

  it('writes the build cache only on a push to main: pull requests read it', () => {
    const job = dockerJob();
    const writes = job.split('\n').filter((line) => line.includes('cache-to='));
    expect(writes.length).toBeGreaterThan(0);
    for (const line of writes)
      expect(line).toMatch(/^ {12}\$\{\{ github\.event_name == 'push' && /);
    expect(read('.github/workflows/ci.yml')).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]\n/m);
  });

  it('runs the steps of web-e2e:e2e-stack, with no spec skipping for want of the seed', () => {
    const job = dockerJob();
    expect(job).toContain('pnpm nx run db:db-seed --excludeTaskDependencies');
    expect(job).toContain('run: docker compose run --rm -T migrate');
    expect(job).toMatch(
      /E2E_SEEDED=1 E2E_REQUIRE_STACK=1 \\\n\s+pnpm nx run web-e2e:e2e-base-url /,
    );
    expect(job).not.toMatch(/\bAPI_URL=/); // the API is private: a step checks its 401 instead
  });
});
