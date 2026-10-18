// tools/agent-hooks/read-only-bash.mjs: the PreToolUse hook that keeps the reviewer subagent
// (.claude/agents/reviewer.md) to commands that read.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { notReadOnly, NX_ALONE, words } from '../agent-hooks/read-only-bash.mjs';
import { codeOf, parseFrontmatter } from '../agents.mjs';
import { nodeBin } from '../lib/bin.mjs';
import { runHook } from './helpers.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const HOOK = resolve(REPO, 'tools/agent-hooks/read-only-bash.mjs');
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

describe('words', () => {
  it('splits like a shell, quotes grouping', () => {
    expect(words(`git log --grep="a b" --format='%h %s'  -- x`)).toEqual([
      'git',
      'log',
      '--grep=a b',
      '--format=%h %s',
      '--',
      'x',
    ]);
    expect(words('git log ""')).toEqual(['git', 'log', '']);
  });

  it('refuses anything a shell would do more with, and open quotes', () => {
    for (const command of [
      'git diff; rm -rf x',
      'git diff && touch x',
      'git diff | sh',
      'git diff > x',
      'git diff < x',
      'git log $(touch x)',
      'git log `touch x`',
      'git log "$HOME"',
      'git log \\; x',
      'git log\ntouch x',
      'git log (x)',
      'git log {a,b}',
      'git log "x',
      'git diff & touch x',
    ])
      expect(words(command), command).toBeUndefined();
  });
});

describe('notReadOnly', () => {
  it.each([
    'git status',
    'git status --short',
    'git diff main...HEAD -- tools/agents.mjs',
    'git log --oneline -20 main..HEAD',
    "git log --format='%h %s' -5",
    'git show HEAD:AGENTS.md',
    'git blame -L 10,20 tools/agents.mjs',
    'git ls-files -co --exclude-standard',
    'git rev-parse HEAD',
    'git merge-base main HEAD',
    'git grep -n testDb -- packages',
    'git branch --show-current',
    'gh pr diff 31',
    'gh pr checks 31',
    'gh run view 123 --log-failed',
    'node tools/pr-review.mjs info --pr 31',
    'node tools/pr-review.mjs diff --pr 31',
    'pnpm nx show projects --affected',
    'pnpm nx show project web --json',
    'pnpm agents:check',
    'pnpm ports',
    'pnpm nx run web:typecheck --excludeTaskDependencies --skipSync',
    'pnpm nx run web:eslint --excludeTaskDependencies --skipSync',
    'pnpm nx run web-e2e:eslint --excludeTaskDependencies --skipSync',
    'pnpm nx run db:test --excludeTaskDependencies --skipSync',
    'pnpm nx affected -t lint eslint typecheck test test-browser --excludeTaskDependencies --skipSync',
    'pnpm nx sync:check',
    'node tools/check.mjs --format',
  ])('lets %s through', (command) => expect(notReadOnly(command)).toBeUndefined());

  it.each([
    ['git commit -m x', 'not on the list'],
    ['git push origin HEAD', 'not on the list'],
    ['git checkout main', 'not on the list'],
    ['git branch -D main', 'not on the list'],
    ['git -c core.pager=touch log', 'not on the list'],
    ['git --no-pager log', 'not on the list'],
    ['git diff --output=x', 'writes a file or runs a command'],
    ['git log --output x', 'writes a file or runs a command'],
    ['git grep -Otouch x', 'writes a file or runs a command'],
    ['git grep --open-files-in-pager=touch x', 'writes a file or runs a command'],
    // git grep's parse-options also takes -O in a cluster and abbreviated
    ['git grep -nOx y', 'writes a file or runs a command'],
    ['git grep -nO y', 'writes a file or runs a command'],
    ['git grep --op=x y', 'writes a file or runs a command'],
    ['git grep --open=x y', 'writes a file or runs a command'],
    ['git grep --open-files=x y', 'writes a file or runs a command'],
    ['git grep --open y', 'writes a file or runs a command'],
    ['GIT_EXTERNAL_DIFF=x git diff', 'not on the list'],
    ['pnpm check', 'not on the list'],
    ['pnpm regen', 'not on the list'],
    ['pnpm format', 'not on the list'],
    ['pnpm db:generate x', 'not on the list'],
    ['pnpm nx run web:build', 'not on the list'],
    ['pnpm nx run web:test --args=x', 'not on the list'],
    ['pnpm nx run web:test --command=x', 'not on the list'],
    ['pnpm nx affected -t test --args=x', 'not on the list'],
    // with the tasks they depend on, checks regenerate tracked files: web:eslint runs
    // api:print-schema first (schema.graphql), web:typecheck codegen and the route generator
    ['pnpm nx run web:eslint', 'not on the list'],
    ['pnpm nx run web:typecheck', 'not on the list'],
    ['pnpm nx run db:test', 'not on the list'],
    // and so do Nx's sync generators (tsconfig references)
    ['pnpm nx run web:typecheck --excludeTaskDependencies', 'not on the list'],
    ['pnpm nx run web:typecheck --skipSync', 'not on the list'],
    ['pnpm nx run web:test --excludeTaskDependencies --skipSync --args=x', 'not on the list'],
    ['pnpm nx run web:build --excludeTaskDependencies --skipSync', 'not on the list'],
    ['pnpm nx run web:codegen --excludeTaskDependencies --skipSync', 'not on the list'],
    ['pnpm nx run api:print-schema --excludeTaskDependencies --skipSync', 'not on the list'],
    ['pnpm nx affected -t lint eslint typecheck test test-browser', 'not on the list'],
    ['pnpm nx affected -t lint eslint typecheck test test-browser build', 'not on the list'],
    // a build regenerates routeTree.gen.ts (TanStack Start's Vite plugin), alone or not
    [
      'pnpm nx affected -t lint eslint typecheck test test-browser build --excludeTaskDependencies --skipSync',
      'not on the list',
    ],
    ['node tools/pr-review.mjs post --pr 31', 'not on the list'],
    ['node tools/check.mjs', 'not on the list'],
    ['gh pr comment 31 -b x', 'not on the list'],
    ['gh api repos/o/r/pulls', 'not on the list'],
    ['cat .env', 'not on the list'],
    ['rm -rf x', 'not on the list'],
    ['git diff; rm -rf x', 'not one plain command'],
    ['', 'not one plain command'],
    [undefined, 'not one plain command'],
  ])('blocks %j: %s', (command, why) => expect(notReadOnly(command)).toContain(why));
});

describe('the Nx checks', () => {
  it('run alone with options this Nx has', () => {
    const [cmd = '', ...pre] = nodeBin(REPO, 'nx') ?? [];
    // nx prints its help on stderr
    const res = spawnSync(cmd, [...pre, 'affected', '--help'], { cwd: REPO, encoding: 'utf8' });
    expect(res.status, res.stderr).toBe(0);
    const help = `${res.stdout}${res.stderr}`;
    for (const option of NX_ALONE.split(' ')) expect(help, option).toContain(` ${option} `);
  });

  it('are named in reviewer.md in the form the hook lets through', () => {
    const md = readFileSync(resolve(REPO, '.claude/agents/reviewer.md'), 'utf8');
    const nx = codeOf(md)
      .filter((c) => /^pnpm nx (?:run <project>:|affected )/.test(c))
      .map((c) => c.replace('<project>', 'web').replace(/<[\w-]+>/, 'eslint'));
    expect(nx.length).toBeGreaterThan(1);
    for (const command of nx) expect(notReadOnly(command), command).toBeUndefined();
  });
});

describe('the hook', () => {
  it('exits 0 for a read-only command, and for other tools', () => {
    expect(runHook(HOOK, bash('git diff main...HEAD')).code).toBe(0);
    expect(runHook(HOOK, { tool_name: 'Read', tool_input: { file_path: 'x' } }).code).toBe(0);
  });

  it('blocks anything else with exit 2, telling the agent what it may run', () => {
    const res = runHook(HOOK, bash('git commit -am x'));
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Blocked: this agent is read-only, and it is not on the list');
    expect(res.stderr).toContain('git status|diff|log');
    expect(res.stderr).toContain('Read files with Read, Grep and Glob');
  });

  it('fails closed on malformed input', () => {
    const res = runHook(HOOK, '{not json');
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('could not parse hook input');
    expect(runHook(HOOK, { tool_name: 'Bash', tool_input: {} }).code).toBe(2);
  });

  it('is what the reviewer subagent runs before each Bash command', () => {
    const text = readFileSync(resolve(REPO, '.claude/agents/reviewer.md'), 'utf8');
    const fm = parseFrontmatter(text);
    expect(fm?.tools).toBe('Read, Grep, Glob, Bash');
    // the hook block of its frontmatter, in exec form (no shell)
    expect(text).toMatch(
      /hooks:\n {2}PreToolUse:\n {4}- matcher: Bash\n {6}hooks:\n {8}- type: command\n {10}command: node\n {10}args: \['\$\{CLAUDE_PROJECT_DIR\}\/tools\/agent-hooks\/read-only-bash\.mjs'\]\n/,
    );
  });
});
