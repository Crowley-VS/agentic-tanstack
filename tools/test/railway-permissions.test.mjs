// Every Railway command an agent could run asks first (docs/deployment-railway.md, "What an agent
// may do"). The Railway plugin (railway@railway-skills) ships a PreToolUse hook that approves the
// railway CLI and its own API script, and a hosted MCP server. A hook's "allow" never skips a
// matching ask rule (Claude Code's permissions docs), so the ask rules below are what hold.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const { permissions } = JSON.parse(readFileSync(join(REPO, '.claude/settings.json'), 'utf8'));

const glob = (pattern) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`, 's');

/**
 * Whether one of `rules` matches a tool call, as Claude Code matches them: `*` anywhere in the
 * rule; ask and deny rules match past leading `VAR=value` assignments, allow rules do not.
 */
function matches(rules, call, { skipAssignments }) {
  const [, tool, command] = call.match(/^(\w+)(?:\((.*)\))?$/s) ?? [];
  const bare = skipAssignments ? command?.replace(/^(?:\w+=\S*\s+)+/, '') : command;
  return rules.some((rule) => {
    const [, ruleTool, pattern] = rule.match(/^([\w*]+)(?:\((.*)\))?$/s) ?? [];
    if (!ruleTool || !glob(ruleTool).test(tool)) return false;
    if (pattern === undefined) return true;
    return [command, bare].some((c) => c !== undefined && glob(pattern).test(c));
  });
}

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
  'mcp__plugin_railway_railway__deploy',
];

describe('Railway permissions', () => {
  it.each(CALLS)('asks before %s', (call) => {
    expect(matches(permissions.ask ?? [], call, { skipAssignments: true })).toBe(true);
  });

  it.each(CALLS)('allows nothing of %s', (call) => {
    expect(matches(permissions.allow ?? [], call, { skipAssignments: false })).toBe(false);
  });

  it('matches rules the way the docs describe', () => {
    expect(matches(['Bash(railway *)'], 'Bash(FOO=1 railway up)', { skipAssignments: true })).toBe(
      true,
    );
    expect(matches(['Bash(railway *)'], 'Bash(FOO=1 railway up)', { skipAssignments: false })).toBe(
      false,
    );
    expect(matches(['Bash(railway *)'], 'Bash(railwayx)', { skipAssignments: true })).toBe(false);
    expect(matches(['mcp__x_*'], 'mcp__x_y__z', { skipAssignments: true })).toBe(true);
    expect(matches(['mcp__x_*'], 'Bash(mcp__x_y)', { skipAssignments: true })).toBe(false);
  });
});
