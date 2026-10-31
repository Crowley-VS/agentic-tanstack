// tools/setup-agents.mjs with fakes: `claude`, `npx`, `typescript-language-server` and Python are small
// scripts alone on PATH, and the script runs from a copy in a temp directory with its own
// .claude/settings.json. Nothing here runs the real `claude plugin install`.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  INSTALL,
  isInstalled,
  projectPlugins,
  pythonVersion,
  shellPath,
} from '../setup-agents.mjs';

const REPO = resolve(import.meta.dirname, '../..');
const SETTINGS = {
  enabledPlugins: {
    'typescript-lsp@claude-plugins-official': true,
    'nx@nx-claude-plugins': true,
    'off@claude-plugins-official': false,
  },
  extraKnownMarketplaces: {
    'nx-claude-plugins': { source: { source: 'github', repo: 'nrwl/nx-ai-agents-config' } },
  },
};
// oxfmt's layout: one-element arrays on one line, unlike JSON.stringify(…, null, 2)
const SETTINGS_TEXT = `${JSON.stringify(SETTINGS, null, 2)}\n`;

const FAKE_CLAUDE = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const env = process.env;
appendFileSync(env.FAKE_LOG, 'claude ' + args.join(' ') + '\\n');
const is = (...words) => words.every((w, i) => args[i] === w);
if (is('--version')) console.log('2.1.300 (Claude Code)');
else if (is('plugin', 'list', '--json')) console.log(env.FAKE_PLUGINS ?? '[]');
else if (is('plugin', 'marketplace', 'list', '--json')) console.log(env.FAKE_MARKETPLACES ?? '[]');
else if (is('plugin', 'marketplace', 'add')) console.log('Successfully added marketplace');
else if (is('plugin', 'install')) {
  if ((env.FAKE_FAIL ?? '').split(',').includes(args[2])) {
    console.error('Failed to install plugin "' + args[2] + '": network down');
    process.exit(1);
  }
  if (env.FAKE_REWRITE) {
    const file = '.claude/settings.json';
    const settings = JSON.parse(readFileSync(file, 'utf8'));
    if (env.FAKE_REWRITE === 'content') settings.enabledPlugins['extra@claude-plugins-official'] = true;
    writeFileSync(file, JSON.stringify(settings, null, 4));
  }
  console.log('Successfully installed plugin: ' + args[2] + ' (scope: project)');
} else {
  console.error('fake claude: unexpected ' + args.join(' '));
  process.exit(64);
}
`;

/** A temp checkout with the script and `settings`, and a bin directory holding `fakes`. */
function machine({
  fakes = ['claude', 'npx', 'typescript-language-server', 'python3'],
  settings,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'setup-agents-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tools'));
  copyFileSync(join(REPO, 'tools/setup-agents.mjs'), join(root, 'tools/setup-agents.mjs'));
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.claude/settings.json'), settings ?? SETTINGS_TEXT);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const scripts = {
    claude: FAKE_CLAUDE,
    npx: "console.log('11.6.2');",
    'typescript-language-server': "console.log('4.3.4');",
    python3: "console.log(process.env.FAKE_PYTHON3 ?? 'Python 3.12.1');",
    python: "console.log(process.env.FAKE_PYTHON ?? 'Python 3.11.2');",
  };
  for (const name of fakes) {
    writeFileSync(join(root, `${name}.mjs`), scripts[name]);
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\nexec "${process.execPath}" "${join(root, `${name}.mjs`)}" "$@"\n`,
    );
    chmodSync(join(bin, name), 0o755);
  }
  return root;
}

/** Run the copy in `root` with only the fakes on PATH. */
function setupAgents(root, args = [], env = {}) {
  const log = join(root, 'claude.log');
  writeFileSync(log, '');
  const res = spawnSync(process.execPath, [join(root, 'tools/setup-agents.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: join(root, 'bin'), FAKE_LOG: log, ...env },
  });
  return {
    code: res.status,
    out: `${res.stdout}${res.stderr}`,
    calls: readFileSync(log, 'utf8').split('\n').filter(Boolean),
    settings: readFileSync(join(root, '.claude/settings.json'), 'utf8'),
  };
}

const READS = [
  'claude --version',
  'claude plugin list --json',
  'claude plugin marketplace list --json',
];
const OFFICIAL = JSON.stringify([{ name: 'claude-plugins-official' }]);
/** The fake `claude plugin list` output: `ids` installed for the user. */
const plugins = (ids) => ({
  FAKE_PLUGINS: JSON.stringify(ids.map((id) => ({ id, scope: 'user' }))),
});

describe('setup-agents', () => {
  it('installs every plugin the project enables, adding a marketplace this machine lacks', () => {
    const root = machine();
    const res = setupAgents(root, [], { FAKE_MARKETPLACES: OFFICIAL });
    expect(res.code, res.out).toBe(0);
    expect(res.calls).toEqual([
      ...READS,
      'claude plugin marketplace add nrwl/nx-ai-agents-config',
      'claude plugin install typescript-lsp@claude-plugins-official --scope project',
      'claude plugin install nx@nx-claude-plugins --scope project',
    ]);
    expect(res.out).toContain(
      'Changed:\n  - added marketplace nx-claude-plugins (nrwl/nx-ai-agents-config) to your user settings\n  - installed plugin typescript-lsp@claude-plugins-official (project scope)\n  - installed plugin nx@nx-claude-plugins (project scope)\n',
    );
    expect(res.out).toContain('Remains for you:\n  nothing');
    expect(res.settings).toBe(SETTINGS_TEXT);
  });

  it('installs only what is not installed for this checkout', () => {
    const root = machine();
    const plugins = [
      { id: 'typescript-lsp@claude-plugins-official', scope: 'user' },
      { id: 'nx@nx-claude-plugins', scope: 'project', projectPath: '/another/checkout' },
    ];
    let res = setupAgents(root, [], {
      FAKE_PLUGINS: JSON.stringify(plugins),
      FAKE_MARKETPLACES: JSON.stringify([{ name: 'nx-claude-plugins' }]),
    });
    expect(res.calls).toEqual([
      ...READS,
      'claude plugin install nx@nx-claude-plugins --scope project',
    ]);
    expect(res.out).toContain('plugin typescript-lsp@claude-plugins-official is installed');

    plugins[1].projectPath = root;
    res = setupAgents(root, [], { FAKE_PLUGINS: JSON.stringify(plugins) });
    expect(res.calls).toEqual(READS.slice(0, 2));
    expect(res.out).toContain('Changed:\n  nothing');
  });

  it('--check changes nothing: it runs only commands that read, and exits 1 when work remains', () => {
    const root = machine();
    const res = setupAgents(root, ['--check'], {
      FAKE_MARKETPLACES: OFFICIAL,
      FAKE_REWRITE: 'format',
    });
    expect(res.code).toBe(1);
    expect(res.calls).toEqual(READS);
    expect(res.out).toContain('a report only, nothing was changed');
    expect(res.out).toContain(
      'Would change:\n  - add marketplace nx-claude-plugins: claude plugin marketplace add nrwl/nx-ai-agents-config\n',
    );
    expect(res.out).toContain(
      '  - install plugin nx@nx-claude-plugins: claude plugin install nx@nx-claude-plugins --scope project',
    );
    expect(res.settings).toBe(SETTINGS_TEXT);

    const done = JSON.stringify(
      ['typescript-lsp@claude-plugins-official', 'nx@nx-claude-plugins'].map((id) => ({
        id,
        scope: 'user',
      })),
    );
    expect(setupAgents(root, ['--check'], { FAKE_PLUGINS: done }).code).toBe(0);
  });

  it('puts .claude/settings.json back when an install only reformatted it', () => {
    const root = machine();
    const res = setupAgents(root, [], { FAKE_MARKETPLACES: OFFICIAL, FAKE_REWRITE: 'format' });
    expect(res.settings).toBe(SETTINGS_TEXT);
    expect(res.out).toContain('Claude Code reformatted it; put back as committed');
  });

  it('keeps and reports any other change to .claude/settings.json', () => {
    const root = machine();
    const res = setupAgents(root, [], { FAKE_MARKETPLACES: OFFICIAL, FAKE_REWRITE: 'content' });
    expect(JSON.parse(res.settings).enabledPlugins).toHaveProperty([
      'extra@claude-plugins-official',
    ]);
    expect(res.out).toContain('review it with `git diff .claude/settings.json`');
  });

  it('reports a failed install with its output and command, and exits 1', () => {
    const root = machine();
    const res = setupAgents(root, [], {
      FAKE_MARKETPLACES: OFFICIAL,
      FAKE_FAIL: 'nx@nx-claude-plugins',
    });
    expect(res.code).toBe(1);
    expect(res.out).toContain(
      'Remains for you:\n  - could not install plugin nx@nx-claude-plugins: claude plugin install nx@nx-claude-plugins --scope project\n    Failed to install plugin "nx@nx-claude-plugins": network down',
    );
    expect(res.out).toContain('installed plugin typescript-lsp@claude-plugins-official');
  });

  it('without claude, says how to get it and installs nothing', () => {
    const root = machine({ fakes: ['typescript-language-server', 'python3'] });
    const res = setupAgents(root);
    expect(res.code).toBe(0);
    expect(res.calls).toEqual([]);
    expect(res.out).toContain(
      `the claude CLI is not on PATH: ${INSTALL.claude}, then run this again`,
    );
    expect(res.out).toContain(
      'plugins to install once claude is there: typescript-lsp@claude-plugins-official, nx@nx-claude-plugins',
    );
    expect(setupAgents(root, ['--check']).code).toBe(1);
  });

  it('checks typescript-language-server and Python 3.8+ (optional)', () => {
    let res = setupAgents(machine(), [], {
      FAKE_PLUGINS: JSON.stringify([
        { id: 'typescript-lsp@claude-plugins-official', scope: 'user' },
        { id: 'nx@nx-claude-plugins', scope: 'user' },
      ]),
    });
    expect(res.out).toContain('In place:\n  - claude 2.1.300 (Claude Code)\n');
    expect(res.out).toContain("  - npx 11.6.2 (the Nx plugin's MCP server)");
    expect(res.out).toContain('  - typescript-language-server 4.3.4 (the typescript-lsp plugin)');
    expect(res.out).toContain('  - Python 3.12 (only the security-guidance opt-in needs it)');
    expect(res.out).toContain('Remains for you:\n  nothing');

    const bare = machine({ fakes: ['python3', 'python'] });
    res = setupAgents(bare, [], { FAKE_PYTHON3: 'Python 2.7.18', FAKE_PYTHON: 'Python 3.9.0' });
    expect(res.out).toContain(`the typescript-lsp plugin needs it: ${INSTALL.tsls}`);
    expect(res.out).toContain('  - Python 3.9 (only the security-guidance opt-in needs it)');
    res = setupAgents(bare, [], { FAKE_PYTHON3: 'Python 2.7.18', FAKE_PYTHON: 'Python 3.7.9' });
    expect(res.out).toContain(`Optional:\n  - no Python 3.8+ on PATH`);
  });

  // proto shims node and pnpm but not npx, so a machine set up with the repo's .prototools can
  // lack it, and the Nx plugin's MCP server then fails to start.
  it('wants npx only when the project enables the Nx plugin', () => {
    const all = ['typescript-lsp@claude-plugins-official', 'nx@nx-claude-plugins'];
    const fakes = ['claude', 'typescript-language-server', 'python3'];
    let res = setupAgents(machine({ fakes }), [], plugins(all));
    expect(res.out).toContain(
      `Remains for you:\n  - npx is not on PATH; the Nx plugin's MCP server starts with it: ${INSTALL.npx}`,
    );
    expect(setupAgents(machine({ fakes }), ['--check'], plugins(all)).code).toBe(1);

    // Under proto's node shim, the Node it runs leads PATH, npx beside it; the shell has none.
    const root = machine({ fakes });
    const nodeBin = join(root, 'proto/tools/node/24.21.0/bin');
    mkdirSync(nodeBin, { recursive: true });
    writeFileSync(join(nodeBin, 'npx'), '#!/bin/sh\necho 11.6.2\n');
    chmodSync(join(nodeBin, 'npx'), 0o755);
    const path = `${nodeBin}:${join(root, 'bin')}`;
    res = setupAgents(root, [], { ...plugins(all), PATH: path });
    expect(res.out).toContain("  - npx 11.6.2 (the Nx plugin's MCP server)");
    const shim = join(root, 'proto/shims/node');
    res = setupAgents(root, [], { ...plugins(all), PATH: path, PROTO_SHIM_PATH: shim });
    expect(res.out).toContain(`npx is not on PATH; the Nx plugin's MCP server starts with it`);
    expect(shellPath({ PATH: path, PROTO_SHIM_PATH: shim })).toBe(join(root, 'bin'));

    const noNx = { enabledPlugins: { 'typescript-lsp@claude-plugins-official': true } };
    res = setupAgents(
      machine({ fakes, settings: `${JSON.stringify(noNx, null, 2)}\n` }),
      [],
      plugins(all.slice(0, 1)),
    );
    expect(res.out).not.toContain('npx');
    expect(res.out).toContain('Remains for you:\n  nothing');
  });

  it('refuses unknown arguments', () => {
    const res = setupAgents(machine(), ['--yes']);
    expect(res.code).toBe(2);
    expect(res.out).toContain('Usage: node tools/setup-agents.mjs [--check]');
    expect(res.calls).toEqual([]);
  });
});

describe('the plugins and marketplaces it reads', () => {
  it('passes on only plain plugin ids and GitHub repos', () => {
    const { ids, sources } = projectPlugins({
      enabledPlugins: { 'a@m': true, 'b@m': false, 'x;rm -rf ~@m': true },
      extraKnownMarketplaces: {
        m: { source: { source: 'github', repo: 'o/r' } },
        bad: { source: { source: 'github', repo: 'o/r; rm -rf ~' } },
        url: { source: { source: 'url', url: 'https://example.com/m.json' } },
      },
    });
    expect(ids).toEqual(['a@m', 'x;rm -rf ~@m']);
    expect(sources).toEqual({
      'claude-plugins-official': 'anthropics/claude-plugins-official',
      m: 'o/r',
    });
    const root = machine({
      settings: JSON.stringify({ enabledPlugins: { 'x;touch y@m': true } }),
    });
    const res = setupAgents(root);
    expect(res.out).toContain('enables "x;touch y@m", which is no plugin@marketplace id: skipped');
    expect(res.calls).toEqual(['claude --version']);
  });

  it("can install every plugin this repo's settings enable", () => {
    const settings = JSON.parse(readFileSync(join(REPO, '.claude/settings.json'), 'utf8'));
    const { ids, sources } = projectPlugins(settings);
    expect(ids).toContain('nx@nx-claude-plugins');
    for (const id of ids) {
      expect(id).toMatch(/^[\w.-]+@[\w.-]+$/);
      expect(sources, id).toHaveProperty([id.split('@')[1]]);
    }
  });

  it('reads installs and Python versions', () => {
    const entries = [{ id: 'a@m', scope: 'project', projectPath: '/x' }];
    expect(isInstalled(entries, 'a@m', '/x')).toBe(true);
    expect(isInstalled(entries, 'a@m', '/y')).toBe(false);
    expect(isInstalled([{ id: 'a@m', scope: 'user' }], 'a@m', '/y')).toBe(true);
    expect(pythonVersion('Python 3.12.1\n')).toEqual([3, 12]);
    expect(pythonVersion('')).toBeUndefined();
  });
});
