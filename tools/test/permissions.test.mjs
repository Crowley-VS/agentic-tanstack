// What .claude/settings.json makes ask first. An ask rule prompts in every permission mode, auto
// included, and an allow rule in any scope (a user's settings.local.json) cannot lift it: so the
// list holds only what must always reach a human, and routine agent work stays off it.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const { permissions } = JSON.parse(readFileSync(join(REPO, '.claude/settings.json'), 'utf8'));

const glob = (pattern) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`, 's');

/**
 * Whether one of `rules` matches a tool call, as Claude Code matches them: `*` anywhere in the
 * rule, and `Bash(x *)` also matches a bare `x`; ask and deny rules match past leading
 * `VAR=value` assignments, allow rules do not.
 */
function matches(rules, call, { skipAssignments }) {
  const [, tool, command] = call.match(/^(\w+)(?:\((.*)\))?$/s) ?? [];
  const bare = skipAssignments ? command?.replace(/^(?:\w+=\S*\s+)+/, '') : command;
  return rules.some((rule) => {
    const [, ruleTool, pattern] = rule.match(/^([\w*]+)(?:\((.*)\))?$/s) ?? [];
    if (!ruleTool || !glob(ruleTool).test(tool)) return false;
    if (pattern === undefined) return true;
    return [command, bare].some(
      (c) =>
        c !== undefined &&
        (glob(pattern).test(c) || (pattern.endsWith(' *') && c === pattern.slice(0, -2))),
    );
  });
}
const asks = (call) => matches(permissions.ask ?? [], call, { skipAssignments: true });
const allows = (call) => matches(permissions.allow ?? [], call, { skipAssignments: false });

it('matches rules the way the docs describe', () => {
  expect(matches(['Bash(railway *)'], 'Bash(FOO=1 railway up)', { skipAssignments: true })).toBe(
    true,
  );
  expect(matches(['Bash(railway *)'], 'Bash(FOO=1 railway up)', { skipAssignments: false })).toBe(
    false,
  );
  expect(matches(['Bash(railway *)'], 'Bash(railway)', { skipAssignments: true })).toBe(true);
  expect(matches(['Bash(railway *)'], 'Bash(railwayx)', { skipAssignments: true })).toBe(false);
  expect(matches(['mcp__x_*'], 'mcp__x_y__z', { skipAssignments: true })).toBe(true);
  expect(matches(['mcp__x_*'], 'Bash(mcp__x_y)', { skipAssignments: true })).toBe(false);
});

// Every Railway command an agent could run asks first (docs/deployment-railway.md, "What an agent
// may do"). The Railway plugin (railway@railway-skills) ships a PreToolUse hook that approves the
// railway CLI and its own API script, and a hosted MCP server; a hook's "allow" never skips a
// matching ask rule.
describe('Railway', () => {
  const HELPER =
    '/home/u/.claude/plugins/cache/railway-skills/railway/1.0.0/skills/use-railway/scripts/railway-api.sh';
  const CALLS = [
    'Bash(railway)',
    'Bash(railway up)',
    'Bash(railway config apply)',
    'Bash(railway variables --set READ_ONLY=true --service web)',
    'Bash(railway login)',
    'Bash(RAILWAY_CALLER=use-railway RAILWAY_AGENT_SESSION=1 railway up --detach)',
    `Bash(${HELPER} 'mutation { serviceDelete(id: "x") }')`,
    `Bash(RAILWAY_CALLER=use-railway ${HELPER} '{ me { email } }')`,
    `Bash(bash ${HELPER} '{ me { email } }')`,
    'mcp__plugin_railway_railway__deploy',
  ];

  it.each(CALLS)('asks before %s', (call) => expect(asks(call)).toBe(true));
  it.each(CALLS)('allows nothing of %s', (call) => expect(allows(call)).toBe(false));

  it('does not ask for a command that only names the API script', () => {
    expect(asks('Bash(grep -n railway-api.sh docs/deployment-railway.md)')).toBe(false);
  });
});

// Agents push their own branches and post review findings without a prompt in auto mode (the
// review loop runs on its own once the user opts in); in the default mode nothing allows a push,
// so each one still asks. What can lose work or skip review always asks: a force push, a push to
// main, a branch deletion.
describe('git push', () => {
  const ROUTINE = [
    'Bash(git push -u origin m7/skills)',
    'Bash(LEFTHOOK=0 git push -q -u origin m6/railway-iac)',
    'Bash(git push origin HEAD:refs/heads/m7/fix-domain)', // the review loop's fixer
    'Bash(git push --follow-tags origin m7/dry-run)',
    'Bash(node tools/pr-review.mjs post --pr 31 --round 1)',
    'Bash(node tools/pr-review.mjs resolve --pr 31 --commit abc1234)',
    'Bash(node tools/pr-review.mjs comment --pr 31)',
    'Bash(pnpm nx run db:db-generate --args="--name=add_tags")',
  ];
  const RISKY = [
    'Bash(git push --force-with-lease origin m7/skills m7/vendored)',
    'Bash(git push --force origin m7/skills)',
    'Bash(git push -f origin m7/skills)',
    'Bash(git push origin -f m7/skills)',
    'Bash(git push origin +m7/skills)',
    'Bash(git push --mirror origin)',
    'Bash(git push origin main)',
    'Bash(git push -u origin main)',
    'Bash(git push origin main --tags)',
    'Bash(git push origin HEAD:main)',
    'Bash(git push origin HEAD:refs/heads/main)',
    'Bash(git push origin --delete m7/skills)',
    'Bash(git push origin -d m7/skills)',
    'Bash(git push origin :m7/skills)',
    // these run a command of the caller's choosing (locally, for a path remote)
    'Bash(git push --receive-pack=./x.sh /tmp/repo m7/skills)',
    'Bash(git push --exec=./x.sh /tmp/repo m7/skills)',
  ];

  it.each(ROUTINE)('does not ask for %s', (call) => expect(asks(call)).toBe(false));
  it.each(RISKY)('asks before %s', (call) => expect(asks(call)).toBe(true));
  it.each([...ROUTINE.slice(0, 4), ...RISKY])('allows nothing of %s', (call) =>
    expect(allows(call)).toBe(false),
  );
});
