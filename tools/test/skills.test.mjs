// The skills point agents at Nx targets: each one they name must exist, so a renamed target fails
// here instead of sending the next agent to a missing one. The repo paths and pnpm scripts they
// name are checked by `node tools/agents.mjs check` (skillReferences), which `pnpm check` and CI
// run uncached (and the pre-commit hook, on commits that touch agent config): a file renamed
// anywhere fails it at once. Targets need the project graph, too slow for that check. This test
// is cached, but its inputs hold what defines targets (every package.json and project.json,
// nx.json, the plugins' config files) and .agents/skills, so changing either runs it again.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeOf, pathTokens, pnpmCommands } from '../agents.mjs';
import { nodeBin } from '../lib/bin.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const SKILLS = readdirSync(join(REPO, '.agents/skills'));
/** The kit's skill: it names no Nx target of this stack. */
const KIT_SKILLS = ['review-loop'];

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
 * The `project:target` pairs named in `code`, for the projects in `projects`: `<p>:<t>` (as in
 * `pnpm nx run web:codegen`, or alone), the `pnpm nx <target> <project>` shorthand, and
 * `pnpm nx run-many -t <targets> -p <projects>`. `pnpm <script>` (`pnpm db:seed`) is no target.
 */
function namedTargets(code, projects) {
  const named = [];
  for (const text of code) {
    for (const m of text.matchAll(/(?<![\w:/@-])([a-z][\w-]*):([a-z][\w-]*)(?![\w:-])/g))
      if (projects.has(m[1]) && !/\bpnpm\s+(?:run\s+)?$/.test(text.slice(0, m.index)))
        named.push(`${m[1]}:${m[2]}`);
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
  const text = readFileSync(join(REPO, '.agents/skills', skill, 'SKILL.md'), 'utf8');
  const code = codeOf(text);

  it('names only Nx targets that exist', () => {
    const targets = nxTargets();
    const named = namedTargets(code, new Set(Object.keys(targets)));
    if (!KIT_SKILLS.includes(skill)) expect(named.length).toBeGreaterThan(0);
    const unknown = named.filter((pt) => !targets[pt.split(':')[0]]?.includes(pt.split(':')[1]));
    expect(unknown, 'not a target: `pnpm nx show project <p> --json`').toEqual([]);
  }, 60_000);

  it('gives `agents.mjs check` its paths and pnpm commands to check', () => {
    // the extraction still sees what the skill names (an empty list would check nothing)
    expect(pathTokens(code).length).toBeGreaterThan(2);
    expect(pnpmCommands(code).length).toBeGreaterThan(0);
  });
});
