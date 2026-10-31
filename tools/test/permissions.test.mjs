// What .claude/settings.json makes ask first, denies and allows. An ask rule prompts in every
// permission mode, auto included, and an allow rule in any scope (a user's settings.local.json)
// cannot lift it: so the list holds only what must always reach a human, and routine agent work
// stays off it. A deny rule cannot be lifted at all. Both match invocations, never a command that
// only mentions one (a grep, a commit message, a review comment).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allowedTools, parseFrontmatter, unsafeAllowRule } from '../agents.mjs';
import { findPackage } from '../vendor-skills.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const { permissions } = JSON.parse(readFileSync(join(REPO, '.claude/settings.json'), 'utf8'));

const glob = (pattern) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`, 's');

/**
 * Whether one of `rules` matches a tool call, as Claude Code matches them: `*` anywhere in the
 * rule, and `Bash(x *)` also matches a bare `x`; ask and deny rules match past leading
 * `VAR=value` assignments, allow rules do not. A rule ending in `:*` is the legacy prefix form:
 * the command or the command followed by a space, any other `*` in it read literally (so
 * `Bash(git push * :*)` matches no real push; `:**` keeps the wildcard).
 */
function matches(rules, call, { skipAssignments }) {
  const [, tool, command] = call.match(/^(\w+)(?:\((.*)\))?$/s) ?? [];
  const bare = skipAssignments ? command?.replace(/^(?:\w+=\S*\s+)+/, '') : command;
  return rules.some((rule) => {
    const [, ruleTool, pattern] = rule.match(/^([\w*]+)(?:\((.*)\))?$/s) ?? [];
    if (!ruleTool || !glob(ruleTool).test(tool)) return false;
    if (pattern === undefined) return true;
    const prefix = pattern.match(/^(.+):\*$/s)?.[1];
    if (prefix !== undefined) {
      return [command, bare].some((c) => c === prefix || c?.startsWith(`${prefix} `));
    }
    return [command, bare].some(
      (c) =>
        c !== undefined &&
        (glob(pattern).test(c) || (pattern.endsWith(' *') && c === pattern.slice(0, -2))),
    );
  });
}
const asks = (call) => matches(permissions.ask ?? [], call, { skipAssignments: true });
const denies = (call) => matches(permissions.deny ?? [], call, { skipAssignments: true });
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
  expect(matches(['Bash(git log:*)'], 'Bash(git log -5)', { skipAssignments: true })).toBe(true);
  expect(matches(['Bash(git push * :*)'], 'Bash(git push origin :x)', {})).toBe(false);
  expect(matches(['Bash(git push * :**)'], 'Bash(git push origin :x)', {})).toBe(true);
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
    // from the script's own directory (Bash keeps its working directory between calls)
    `Bash(railway-api.sh 'mutation { serviceDelete(id: "x") }')`,
    `Bash(bash railway-api.sh '{ me { email } }')`,
    `Bash(sh railway-api.sh '{ me { email } }')`,
    `Bash(./railway-api.sh '{ me { email } }')`,
    'mcp__plugin_railway_railway__deploy',
  ];

  it.each(CALLS)('asks before %s', (call) => expect(asks(call)).toBe(true));
  it.each(CALLS)('allows nothing of %s', (call) => expect(allows(call)).toBe(false));

  it('does not ask for a command that only names the API script', () => {
    expect(asks('Bash(grep -n railway-api.sh docs/deployment-railway.md)')).toBe(false);
    expect(asks('Bash(rg railway-api.sh docs)')).toBe(false);
  });
});

// Agents push their own branches and post review findings without a prompt in auto mode (the
// review loop runs on its own once the user opts in); in the default mode nothing allows a push,
// so each one still asks. What can lose work or skip review always asks: a force push, a push to
// main, a branch deletion. No rule sees the current branch: a push that names no branch
// (`git push`, `git push origin`, `git push -u origin`) pushes the checked-out one, main included,
// and does not ask; that is why work never gets committed on main (AGENTS.md). A short-option
// bundle is caught when f or d comes first, or second after u, q or v (`-uf`, `-qf`, `-vf`).
describe('git push', () => {
  const ROUTINE_PUSHES = [
    'Bash(git push -u origin m7/skills)',
    'Bash(LEFTHOOK=0 git push -q -u origin m6/railway-iac)',
    'Bash(git push origin HEAD:refs/heads/m7/fix-domain)', // the review loop's fixer
    'Bash(git push --follow-tags origin m7/dry-run)',
    'Bash(git push --dry-run origin m7/skills)',
    'Bash(git push -u origin m7/maintenance)',
    'Bash(git push -u origin m7/head-to-main-docs)',
  ];
  const ROUTINE = [
    ...ROUTINE_PUSHES,
    'Bash(node tools/pr-review.mjs post --pr 31 --round 1)',
    'Bash(node tools/pr-review.mjs resolve --pr 31 --commit abc1234)',
    'Bash(node tools/pr-review.mjs comment --pr 31)',
  ];
  const RISKY = [
    'Bash(git push --force-with-lease origin m7/skills m7/vendored)',
    'Bash(git push --force origin m7/skills)',
    'Bash(git push -f origin m7/skills)',
    'Bash(git push origin -f m7/skills)',
    'Bash(git push -fu origin m7/skills)',
    'Bash(git push -uf origin m7/skills)',
    'Bash(git push origin -uf m7/skills)',
    'Bash(git push -qf origin m7/skills)',
    'Bash(git push -vf origin m7/skills)',
    'Bash(git push origin +m7/skills)',
    'Bash(git push --mirror origin)',
    'Bash(git push origin main)',
    'Bash(git push -u origin main)',
    'Bash(git push origin main --tags)',
    'Bash(git push origin HEAD:main)',
    'Bash(git push origin HEAD:refs/heads/main)',
    'Bash(git push origin refs/heads/main)',
    'Bash(git push origin refs/heads/main --tags)',
    // HEAD is main whenever main is checked out
    'Bash(git push origin HEAD)',
    'Bash(git push -u origin HEAD)',
    'Bash(git push origin HEAD --tags)',
    'Bash(git push origin @)',
    // every branch, main included
    'Bash(git push --all origin)',
    'Bash(git push origin --all)',
    'Bash(git push --branches origin)',
    // branch deletions
    'Bash(git push origin --delete m7/skills)',
    'Bash(git push origin -d m7/skills)',
    'Bash(git push -d origin m7/skills)',
    'Bash(git push origin :m7/skills)',
    'Bash(git push origin :m7/skills --verbose)',
    'Bash(git push --prune origin refs/heads/*:refs/heads/*)',
    // these run a command of the caller's choosing (locally, for a path remote)
    'Bash(git push --receive-pack=./x.sh /tmp/repo m7/skills)',
    'Bash(git push --exec=./x.sh /tmp/repo m7/skills)',
  ];

  it.each(ROUTINE)('does not ask for %s', (call) => expect(asks(call)).toBe(false));
  it.each(RISKY)('asks before %s', (call) => expect(asks(call)).toBe(true));
  it.each([...ROUTINE_PUSHES, ...RISKY])('allows nothing of %s', (call) =>
    expect(allows(call)).toBe(false),
  );
});

// The local dev database is routine agent work, however destructive to its (reseedable) rows: no
// ask rule, so auto mode runs it and a user may allow it in their settings.local.json. A reset
// wipes only this checkout's own server: it refuses one COMPOSE_PROJECT_NAME shares with other
// checkouts (packages/db/src/db-up.test.ts, 'reset refuses a project …'). Nothing here allows
// the commands that wipe it or open a client through Nx (`db-psql --args='-c "…"'` runs any SQL,
// and any shell command), so the default mode still asks for them; `pnpm db:psql` (below) is the
// client a wildcard rule can allow. Dependencies always ask.
describe('database and dependencies', () => {
  const DEPENDENCIES = [
    'Bash(pnpm add zod --filter @acme/db)',
    'Bash(pnpm remove zod --filter @acme/db)',
    'Bash(pnpm dlx cowsay hi)',
  ];
  const LOCAL_DB = [
    'Bash(pnpm nx run db:db-psql)',
    `Bash(pnpm nx run db:db-psql --args='-c "drop table notes"')`,
    `Bash(pnpm nx db-psql db --args='-c "truncate notes"')`,
    'Bash(pnpm nx run db:db-reset)',
    'Bash(pnpm nx run db:db-reset --verbose)',
    'Bash(pnpm nx db-reset db)',
    'Bash(pnpm nx run db:db-studio)',
    'Bash(pnpm db:reset)',
    'Bash(pnpm db:reset --verbose)',
    'Bash(pnpm db:studio)',
  ];
  const ROUTINE = [
    'Bash(pnpm db:up)',
    'Bash(pnpm db:migrate)',
    'Bash(pnpm db:seed)',
    'Bash(pnpm nx run db:db-generate --args="--name=add_tags")',
    'Bash(pnpm nx run db:test)',
  ];

  it.each(DEPENDENCIES)('asks before %s', (call) => expect(asks(call)).toBe(true));
  it.each([...DEPENDENCIES, ...LOCAL_DB])('allows nothing of %s', (call) =>
    expect(allows(call)).toBe(false),
  );
  it.each([...LOCAL_DB, ...ROUTINE])('does not ask for %s', (call) =>
    expect(asks(call)).toBe(false),
  );
});

// What writes agent config, or unrewritten skills over the vendored ones, is denied (AGENTS.md:
// never `nx configure-ai-agents`, `intent install` or `intent hooks`; the vendored skills say why
// for the browser CLI's and drizzle-kit's installers): through `pnpm exec <bin>`, the bare
// `pnpm <bin>`, a filter or a download-latest runner. A command that only names one is not.
describe('agent config and skill installers', () => {
  const DENIED = [
    'Bash(npx @playwright/cli@latest install --skills)',
    'Bash(playwright-cli open)',
    'Bash(playwright-cli install --skills)',
    'Bash(pnpm dlx @playwright/cli@latest install --skills)',
    'Bash(pnpm exec playwright cli install)',
    'Bash(pnpm exec playwright cli install --skills)',
    'Bash(pnpm playwright cli install --skills)',
    'Bash(pnpm exec playwright init-skills)',
    'Bash(pnpm playwright init-skills)',
    'Bash(pnpm exec intent install)',
    'Bash(pnpm intent install)',
    'Bash(pnpm exec intent hooks install)',
    'Bash(pnpm intent hooks install)',
    'Bash(pnpm dlx @tanstack/intent@latest install)',
    'Bash(drizzle-kit skills)',
    'Bash(pnpm exec drizzle-kit skills)',
    'Bash(pnpm drizzle-kit skills)',
    'Bash(pnpm --filter @acme/db exec drizzle-kit skills)',
    'Bash(pnpm -C packages/db exec drizzle-kit skills --force)',
    'Bash(pnpm dlx drizzle-kit skills)',
    'Bash(pnpm dlx drizzle-kit@latest skills)',
    'Bash(packages/db/node_modules/.bin/drizzle-kit skills)',
    'Bash(CI=1 pnpm exec drizzle-kit skills)',
    'Bash(npx drizzle-kit skills)',
    'Bash(pnpm nx configure-ai-agents --agents claude)',
    'Bash(pnpm agents:nx)',
  ];
  const NOT_DENIED = [
    // mentions
    'Bash(grep -rn "drizzle-kit skills" .agents/skills)',
    'Bash(git commit -m "docs: never run drizzle-kit skills")',
    "Bash(git log -S 'drizzle-kit skills' --oneline)",
    'Bash(rg "pnpm exec intent install" docs)',
    'Bash(node tools/pr-review.mjs post --pr 33 --round 1)',
    // other commands of the same tools
    'Bash(pnpm exec playwright cli install-browser chromium)',
    'Bash(pnpm exec playwright install chromium)',
    'Bash(pnpm exec intent list)',
    'Bash(pnpm exec intent load drizzle-kit#drizzle-output-modes)',
    'Bash(pnpm nx run db:db-generate --args="--name=add_tags")',
  ];

  it.each(DENIED)('denies %s', (call) => expect(denies(call)).toBe(true));
  it.each(NOT_DENIED)('does not deny %s', (call) => expect(denies(call)).toBe(false));
});

// The browser CLI and Intent run without a prompt for reading and driving the page; nothing that
// runs code, writes a file the caller picks or installs anything. The vendored playwright-cli
// skill's allowed-tools approve too, while it runs.
const SKILL_TOOLS = allowedTools(
  parseFrontmatter(readFileSync(join(REPO, '.agents/skills/playwright-cli/SKILL.md'), 'utf8'))?.[
    'allowed-tools'
  ],
);
const skillAllows = (call) => matches(SKILL_TOOLS, call, { skipAssignments: false });

describe('the browser CLI and Intent', () => {
  const CLI = 'pnpm exec playwright cli';
  const ALLOWED = [
    `${CLI} --help`,
    `${CLI} --help snapshot`,
    `${CLI} open`,
    `${CLI} open --browser=chromium`,
    `${CLI} snapshot`,
    `${CLI} find "Sign in"`,
    `${CLI} console error`,
    `${CLI} requests --filter "/api/.*"`,
    `${CLI} tab-list`,
    `${CLI} reload`,
    `${CLI} list`,
    `${CLI} close`,
    `${CLI} close-all`,
    'pnpm exec intent list',
    'pnpm exec intent list --json',
    'pnpm exec intent load @tanstack/router-core#router-core',
  ].map((c) => `Bash(${c})`);
  const SKILL_ONLY = [`${CLI} goto http://localhost:54800`, `${CLI} click e15`, `${CLI} fill e3 x`];
  const NOT_ALLOWED = [
    `${CLI} run-code "async page => page.goto('x')"`,
    `${CLI} eval "document.cookie"`,
    `${CLI} open --config=evil.json`,
    `${CLI} open http://localhost:54800 --profile=/tmp/x`,
    `${CLI} snapshot --filename=../x.md`,
    `${CLI} screenshot --filename=x.png`,
    `${CLI} pdf`,
    `${CLI} state-save auth.json`,
    `${CLI} state-load auth.json`,
    `${CLI} route "**/api/**" --body x`,
    `${CLI} upload /etc/passwd`,
    `${CLI} video-start`,
    `${CLI} tracing-start`,
    `${CLI} install --skills`,
    `${CLI} -s=other run-code x`,
    'pnpm exec intent install',
    'pnpm exec intent hooks install',
  ].map((c) => `Bash(${c})`);

  it.each(ALLOWED)('allows %s', (call) => expect(allows(call)).toBe(true));
  it.each(SKILL_ONLY.map((c) => `Bash(${c})`))('the skill allows %s while it runs', (call) =>
    expect(skillAllows(call)).toBe(true),
  );
  it.each(NOT_ALLOWED)('allows nothing of %s', (call) => {
    expect(allows(call)).toBe(false);
    expect(skillAllows(call)).toBe(false);
  });
});

// Each browser CLI command that runs without a prompt (settings allow rules, the skill's
// allowed-tools) is one reviewed here: it cannot run code or write a file the caller picks (no
// run-code, eval, open --config or --profile, snapshot or screenshot --filename, state-save,
// route, upload, video, tracing). A widened rule (`Bash(pnpm exec playwright cli *)`) fails here,
// and so does a Playwright bump that gives a wildcard-approved command a new option.
describe('what the browser CLI may do without a prompt', () => {
  /** Commands allowed exactly as written (no arguments). */
  const EXACT = [
    'open',
    'open --browser=chromium',
    'snapshot',
    'go-back',
    'go-forward',
    'reload',
    'tab-list',
    'list',
    'close',
    'close-all',
  ];
  /** Commands allowed with any arguments (`<command> *`), and every option each has. */
  const WILDCARD = {
    goto: [],
    find: ['regex'],
    click: ['modifiers'],
    dblclick: ['modifiers'],
    fill: ['submit'],
    type: ['submit'],
    press: [],
    hover: [],
    select: [],
    check: [],
    uncheck: [],
    console: ['clear'],
    requests: ['clear', 'filter', 'static'],
  };
  const SPELLINGS = ['pnpm exec playwright cli', 'pnpm playwright cli'];
  /** Whether allow rule `rule` can approve a browser CLI command. */
  function reachesCli(rule) {
    if (rule === 'Bash') return true;
    const content = rule.match(/^Bash\((.*)\)$/s)?.[1]?.replace(/:\*$/, ' *');
    if (content === undefined) return false;
    const star = content.indexOf('*');
    return SPELLINGS.some(
      (cli) =>
        content.startsWith(cli) || (star !== -1 && `${cli} `.startsWith(content.slice(0, star))),
    );
  }
  /** Whether `rule` is one reviewed here. */
  function reviewed(rule) {
    const command = rule.match(/^Bash\(pnpm exec playwright cli (.*)\)$/s)?.[1];
    if (command === undefined) return false;
    if (command === '--help *' || EXACT.includes(command)) return true; // --help prints help only
    const name = command.match(/^([\w-]+) \*$/)?.[1];
    return name !== undefined && Object.hasOwn(WILDCARD, name);
  }

  it('finds the rules that reach the CLI, however they are spelled', () => {
    for (const rule of [
      'Bash',
      'Bash(*)',
      'Bash(pnpm *)',
      'Bash(pnpm exec playwright *)',
      'Bash(pnpm exec playwright cli *)',
      'Bash(pnpm exec playwright cli:*)',
      'Bash(pnpm exec playwright cli run-code *)',
      'Bash(pnpm playwright cli eval *)',
    ]) {
      expect(reachesCli(rule), rule).toBe(true);
      expect(reviewed(rule), rule).toBe(false);
    }
    expect(reachesCli('Bash(pnpm check *)')).toBe(false);
    expect(reachesCli('Bash(pnpm exec intent list *)')).toBe(false);
  });

  it.each([
    ['.claude/settings.json allow', permissions.allow ?? []],
    ['the playwright-cli skill allowed-tools', SKILL_TOOLS],
  ])('%s approve only reviewed browser CLI commands', (_, rules) => {
    expect(rules.filter((r) => reachesCli(r) && !reviewed(r))).toEqual([]);
  });

  it('reads the skill allowed-tools (an empty list would check nothing)', () => {
    expect(SKILL_TOOLS.filter(reachesCli).length).toBeGreaterThan(Object.keys(WILDCARD).length);
  });

  it('every option of a command approved with any arguments is one reviewed here', () => {
    const { packages } = JSON.parse(readFileSync(join(REPO, '.agents/vendor.json'), 'utf8'));
    const dir = findPackage(REPO, 'playwright-core', packages['playwright-core']);
    expect(dir, 'playwright-core is not installed: run `pnpm install`').toBeDefined();
    const { commands } = JSON.parse(
      readFileSync(join(dir ?? '', 'lib/tools/cli-client/help.json'), 'utf8'),
    );
    for (const command of EXACT) expect(commands[command.split(' ')[0]], command).toBeDefined();
    for (const [command, options] of Object.entries(WILDCARD))
      expect(Object.keys(commands[command]?.flags ?? {}).toSorted(), command).toEqual(options);
  });
});

// `pnpm db:generate` checks every argument before anything runs and starts drizzle-kit without a
// shell (packages/db/scripts/db-generate.mjs), so a wildcard rule for it approves nothing else.
// The proof is packages/db/src/db-generate.test.ts, which runs shell syntax and quotes through
// `pnpm db:generate` and gets each one refused whole, nothing run. A rule for the db:db-generate
// Nx target would approve any command: its --args reach a shell. (Not on native Windows, which
// the repo does not support: pnpm runs root scripts through cmd.exe there, docs/database.md.)
describe('pnpm db:generate', () => {
  const RULE = 'Bash(pnpm db:generate *)';
  // RULE is in .claude/settings.json (a human put it there: agents cannot edit that file), so a
  // migration runs without a prompt. APPLIED follows the file, so these tests still pin what the
  // rule approves (these calls, nothing else) if a human takes it out again.
  const APPLIED = permissions.allow.includes(RULE);
  const CALLS = [
    'Bash(pnpm db:generate add_tags)',
    'Bash(pnpm db:generate backfill_tags --custom)',
    'Bash(pnpm db:generate add_tags --output json --explain)',
    'Bash(pnpm db:generate add_tags --output json --hints-file .agents/ignore/hints.json)',
  ];

  // unsafeAllowRule knows the git, gh and Nx shapes only (it passes `Bash(rm -rf *)` too): this
  // pins that pnpm agents:check accepts RULE, not that RULE is safe (that is db-generate.test.ts)
  it('is not one of the rule shapes unsafeAllowRule rejects, unlike the db:db-generate target', () => {
    expect(unsafeAllowRule(RULE)).toBeUndefined();
    expect(unsafeAllowRule('Bash(pnpm nx run db:db-generate *)')).toMatch(/any shell command/);
  });
  it.each(CALLS)('never asks for %s', (call) => expect(asks(call)).toBe(false));
  it.each(CALLS)('allows %s just when settings.json has the rule', (call) =>
    expect(allows(call)).toBe(APPLIED),
  );
  it('approves no other command', () => {
    for (const call of ['Bash(pnpm db:generatex)', 'Bash(pnpm db:migrate x)', 'Bash(pnpm x)'])
      expect(matches([RULE], call, { skipAssignments: false }), call).toBe(false);
  });
});

// `pnpm db:psql` hands psql each argument as one word: pnpm quotes each one for the shell it runs
// a root script in, and packages/db/scripts/db-up.mjs passes them to `docker compose exec` as an
// argv array, after psql's name. So a wildcard rule for it approves psql in this checkout's
// Postgres container and nothing else: any SQL on any database of its server, and any command
// inside the container (psql's `\!`, COPY … TO PROGRAM), which has network access but no mount of
// the checkout. The proof is the round trip in packages/db/src/db-up.test.ts ('pnpm db:psql
// passes each argument to psql intact'), which runs commas, quotes and shell syntax through it
// where the compose server runs. A rule for the db:db-psql Nx target would approve any command on
// this machine: its --args reach a shell. (Not on native Windows: docs/database.md.)
describe('pnpm db:psql', () => {
  const RULE = 'Bash(pnpm db:psql *)';
  // RULE is not in .claude/settings.json: a user may add it to their settings.local.json
  // (docs/agents.md), and a human may move it into the shared file. APPLIED follows that file.
  const APPLIED = permissions.allow.includes(RULE);
  const CALLS = [
    'Bash(pnpm db:psql)',
    'Bash(pnpm db:psql -c "select 1 as a, 2 as b")',
    `Bash(pnpm db:psql -tA -c "select title, count(*) from notes group by title")`,
    `Bash(pnpm db:psql -c "truncate comments")`,
  ];

  // as for db:generate: this pins that pnpm agents:check would accept RULE, not that it is safe
  it('is not one of the rule shapes unsafeAllowRule rejects, unlike the db:db-psql target', () => {
    expect(unsafeAllowRule(RULE)).toBeUndefined();
    expect(unsafeAllowRule('Bash(pnpm nx run db:db-psql *)')).toMatch(/any shell command/);
  });
  it.each(CALLS)('never asks for %s', (call) => expect(asks(call)).toBe(false));
  it.each(CALLS)('allows %s just when settings.json has the rule', (call) =>
    expect(allows(call)).toBe(APPLIED),
  );
  it('approves no other command', () => {
    for (const call of [
      'Bash(pnpm db:psqlx)',
      'Bash(pnpm db:reset)',
      `Bash(pnpm nx run db:db-psql --args='-c "select 1"')`,
    ])
      expect(matches([RULE], call, { skipAssignments: false }), call).toBe(false);
  });
});
