#!/usr/bin/env node
// Claude Code PreToolUse hook (Bash) for a read-only subagent: .claude/agents/reviewer.md runs it
// from its frontmatter. A subagent's `tools` can only grant or remove the whole Bash tool, so this
// hook narrows it: it lets through only the commands in READ_ONLY (git's read commands, the PR's
// diff and checks, the project graph, and checks that change no tracked file), each as one plain
// command. Anything else is blocked (exit 2, the reason on stderr), and so is any command with a
// character a shell would act on: chaining, pipes, redirects, substitution, escapes, newlines.
// A command it lets through still goes through the permission rules: it never approves anything.
// Fails CLOSED on malformed input.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Characters that make a shell do more than run one command with these words. */
const SHELL = /[;&|<>$`\\\n\r(){}]/;
/** git options that write a file (`git log --output=<file>`) or run a command (`git grep -O<cmd>`). */
const GIT_WRITES = /^(?:--output\b|-O|--open-files-in-pager\b)/;
/** git grep also takes -O inside a cluster of short options (`-nO<cmd>`) and abbreviated (`--open=<cmd>`). */
const GREP_PAGER = /^(?:-[^-]*O|--op(?:e(?:n(?:-[\w-]*)?)?)?(?:=|$))/;
const CHECK_TARGETS = 'lint|eslint|typecheck|test|test-browser';

/**
 * What a read-only agent may run: [pattern over the command's words joined by one space, what to
 * call it in the message]. A command matches when the whole of it matches.
 */
export const READ_ONLY = [
  [
    /^git (?:status|diff|log|show|blame|ls-files|rev-parse|merge-base|grep)(?: .*)?$/,
    'git status|diff|log|show|blame|ls-files|rev-parse|merge-base|grep …',
  ],
  [/^git branch --show-current$/, 'git branch --show-current'],
  [/^gh pr (?:diff|checks)(?: .*)?$/, 'gh pr diff|checks …'],
  [/^gh run view(?: .*)?$/, 'gh run view …'],
  [
    /^node tools\/pr-review\.mjs (?:info|head|diff|threads)(?: .*)?$/,
    'node tools/pr-review.mjs info|head|diff|threads …',
  ],
  [/^pnpm nx show(?: .*)?$/, 'pnpm nx show …'],
  [/^pnpm (?:agents:check|ports)$/, 'pnpm agents:check, pnpm ports'],
  [
    new RegExp(`^pnpm nx run [\\w-]+:(?:${CHECK_TARGETS})$`),
    `pnpm nx run <project>:<${CHECK_TARGETS}>`,
  ],
  [
    /^pnpm nx affected -t lint eslint typecheck test test-browser(?: build)?$/,
    'pnpm nx affected -t lint eslint typecheck test test-browser [build]',
  ],
  [/^pnpm nx sync:check$/, 'pnpm nx sync:check'],
  [
    /^node tools\/check\.mjs (?:--format|--lint-loose)$/,
    'node tools/check.mjs --format|--lint-loose',
  ],
];

/**
 * The words of `command` (quotes group, as a shell would), or undefined when a shell would do
 * more with it than run one command (see SHELL) or a quote is not closed.
 */
export function words(command) {
  if (SHELL.test(command)) return undefined;
  const out = [];
  let word;
  let quote;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      word ??= '';
    } else if (/\s/.test(ch)) {
      if (word !== undefined) out.push(word);
      word = undefined;
    } else word = (word ?? '') + ch;
  }
  if (quote) return undefined;
  if (word !== undefined) out.push(word);
  return out;
}

/** Why `command` is not read-only, or undefined when a read-only agent may run it. */
export function notReadOnly(command) {
  const argv = words(String(command ?? '').trim());
  if (!argv || argv.length === 0)
    return 'it is not one plain command (no ; & | < > $ ` \\ ( ) { } or newlines)';
  if (
    argv[0] === 'git' &&
    argv.slice(1).some((a) => GIT_WRITES.test(a) || (argv[1] === 'grep' && GREP_PAGER.test(a)))
  )
    return 'this git option writes a file or runs a command';
  const line = argv.join(' ');
  return READ_ONLY.some(([pattern]) => pattern.test(line)) ? undefined : 'it is not on the list';
}

function main() {
  let command;
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    if (input?.tool_name !== undefined && input.tool_name !== 'Bash') process.exit(0);
    command = input?.tool_input?.command;
  } catch (err) {
    process.stderr.write(`read-only-bash: could not parse hook input (${err.message}); blocked.\n`);
    process.exit(2);
  }
  const why = notReadOnly(command);
  if (!why) process.exit(0);
  process.stderr.write(
    `Blocked: this agent is read-only, and ${why}. It may run, as one plain command:\n${READ_ONLY.map(([, name]) => `  ${name}`).join('\n')}\nRead files with Read, Grep and Glob.\n`,
  );
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
