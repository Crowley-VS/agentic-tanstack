// The skills point agents at Nx targets: each one they name must exist, so a renamed target fails
// here instead of sending the next agent to a missing one. The repo paths and pnpm scripts they
// name are checked by `node tools/agents.mjs check` (skillReferences), which `pnpm check` and CI
// run uncached (and the pre-commit hook, on commits that touch agent config): a file renamed
// anywhere fails it at once. Targets need the project graph, too slow for that check. This test
// is cached, but its inputs hold what defines targets (every package.json and project.json,
// nx.json, the plugins' config files) and .agents/skills, so changing either runs it again.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeOf, pathTokens, pnpmCommands } from '../agents.mjs';
import { nodeBin } from '../lib/bin.mjs';

const REPO = resolve(import.meta.dirname, '../..');
/** The skills: directories with a SKILL.md (a stray file, such as macOS's .DS_Store, is none). */
const SKILLS = readdirSync(join(REPO, '.agents/skills'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(REPO, '.agents/skills', d.name, 'SKILL.md')))
  .map((d) => d.name);
const codeOfSkill = (skill) =>
  codeOf(readFileSync(join(REPO, '.agents/skills', skill, 'SKILL.md'), 'utf8'));

let graphTargets;
/** Every Nx project's targets, from one `nx graph --print` (once per run). */
function nxTargets() {
  graphTargets ??= readTargets();
  return graphTargets;
}
function readTargets() {
  const [cmd = '', ...pre] = nodeBin(REPO, 'nx') ?? [];
  const { graph } = JSON.parse(
    execFileSync(cmd, [...pre, 'graph', '--print'], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  return Object.fromEntries(
    Object.entries(graph.nodes).map(([name, node]) => [name, Object.keys(node.data.targets ?? {})]),
  );
}

/**
 * The `project:target` pairs named in `code`: `nx run <p>:<t>` (whatever p is: an unknown project
 * fails too), a bare `<p>:<t>` of a project in `projects` (`scope:web` is a tag), the
 * `pnpm nx <target> <project>` shorthand, and `pnpm nx run-many -t <targets> -p <projects>`.
 * `pnpm <script>` (`pnpm db:seed`) is no target.
 */
function namedTargets(code, projects) {
  const named = [];
  for (const text of code) {
    for (const m of text.matchAll(/(?<![\w:/@-])([a-z][\w-]*):([a-z][\w-]*)(?![\w:-])/g)) {
      const before = text.slice(0, m.index);
      if (
        /\bnx\s+run\s+$/.test(before) ||
        (projects.has(m[1]) && !/\bpnpm\s+(?:run\s+)?$/.test(before))
      )
        named.push(`${m[1]}:${m[2]}`);
    }
    for (const m of text.matchAll(/pnpm nx (?!run )([a-z][\w-]*) ([a-z][\w-]*)(?![\w:-])/g))
      if (projects.has(m[2])) named.push(`${m[2]}:${m[1]}`);
    for (const m of text.matchAll(/pnpm nx run-many((?:\s+[^\s|;&]+)+)/g)) {
      const words = m[1].trim().split(/\s+/);
      const after = (flag) => {
        const i = words.indexOf(flag);
        if (i === -1) return [];
        const end = words.findIndex((w, j) => j > i && w.startsWith('-'));
        return words.slice(i + 1, end === -1 ? undefined : end);
      };
      for (const project of after('-p'))
        for (const target of after('-t')) named.push(`${project}:${target}`);
    }
  }
  return named;
}

describe('namedTargets', () => {
  it('finds project:target pairs, the shorthand and run-many, never pnpm scripts', () => {
    const projects = new Set(['web', 'db', 'web-e2e']);
    const code = [
      'pnpm nx run web:codegen',
      'pnpm nx run webapp:build and nx run wbe:e2e', // unknown projects: reported, not skipped
      'db:db-check',
      'pnpm db:seed',
      'pnpm run db:seed',
      'pnpm nx e2e web-e2e -- src/x.spec.ts',
      'pnpm nx run-many -t serve-e2e build -p web db --parallel',
      'pnpm nx show project web',
      'type:e2e and scope:web',
      '@acme/db:x',
    ];
    expect(namedTargets(code, projects)).toEqual([
      'web:codegen',
      'webapp:build',
      'wbe:e2e',
      'db:db-check',
      'web-e2e:e2e',
      'web:serve-e2e',
      'web:build',
      'db:serve-e2e',
      'db:build',
    ]);
  });
});

describe.each(SKILLS)('skill %s', (skill) => {
  it('names only Nx targets that exist', () => {
    const targets = nxTargets();
    const named = namedTargets(codeOfSkill(skill), new Set(Object.keys(targets)));
    const unknown = named.filter((pt) => !targets[pt.split(':')[0]]?.includes(pt.split(':')[1]));
    expect(unknown, 'not a target: `pnpm nx show project <p> --json`').toEqual([]);
  }, 60_000);
});

describe('the skills, together', () => {
  it('give the checks something to check: targets, paths and pnpm commands', () => {
    // guards the extractors against a regression that finds nothing (and so checks nothing)
    const code = SKILLS.flatMap(codeOfSkill);
    expect(namedTargets(code, new Set(Object.keys(nxTargets()))).length).toBeGreaterThan(0);
    expect(pathTokens(code).length).toBeGreaterThan(0);
    expect(pnpmCommands(code).length).toBeGreaterThan(0);
  }, 60_000);
});
