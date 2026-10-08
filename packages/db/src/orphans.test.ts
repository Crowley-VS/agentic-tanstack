// scripts/orphans.mjs: which Docker resources are leftovers of this repository's deleted
// checkouts (pure), and removing them from a real Docker (resources labeled with a commonDir no
// real checkout has, so nothing else on the machine is ever a candidate).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script
import * as orphans from '../scripts/orphans.mjs';

const { describePruned, findOrphans, LABELS, parseListing, pruneOrphans } = orphans;
const tmp = mkdtempSync(join(tmpdir(), 'orphans-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const REPO = '/src/app/.git';
const LIVE = '/src/app/.claude/worktrees/live';
const GONE = '/src/app/.claude/worktrees/gone';
const exists = (dir: string) => ['/src/app', LIVE].includes(dir);
type Resource = {
  id: string;
  project: string;
  workingDir?: string;
  commonDir?: string;
  root?: string;
};
const r = (res: Resource) => ({ workingDir: '', commonDir: '', root: '', ...res });
/** A compose project as db-up makes it: a container, a volume and a network. */
const project = (name: string, root: string, commonDir = REPO) => ({
  containers: [r({ id: `${name}-c`, project: name, workingDir: root, commonDir, root })],
  volumes: [r({ id: `${name}_pgdata`, project: name, commonDir, root })],
  networks: [r({ id: `${name}_default`, project: name })],
});
const merge = (...parts: ReturnType<typeof project>[]) => ({
  containers: parts.flatMap((p) => p.containers),
  volumes: parts.flatMap((p) => p.volumes),
  networks: parts.flatMap((p) => p.networks),
});

describe('findOrphans', () => {
  it('finds the container, volume and network of a deleted checkout, and nothing of a live one', () => {
    const found = findOrphans(merge(project('gone-1', GONE), project('live-2', LIVE)), {
      commonDir: REPO,
      exists,
    });
    expect(found).toEqual({
      projects: [{ project: 'gone-1', root: GONE }],
      containers: ['gone-1-c'],
      volumes: ['gone-1_pgdata'],
      networks: ['gone-1_default'],
    });
  });

  it('finds a volume left alone after `pnpm teardown` removed its container and network', () => {
    const { volumes } = project('gone-1', GONE);
    expect(
      findOrphans({ containers: [], volumes, networks: [] }, { commonDir: REPO, exists }),
    ).toMatchObject({ volumes: ['gone-1_pgdata'], containers: [], networks: [] });
  });

  it('never touches another repository’s resources, even when their checkout is gone', () => {
    const decoy = project('app-gone-1', GONE, '/elsewhere/app/.git');
    const unlabeled = project('app-gone-2', GONE, ''); // e.g. a bare `docker compose up`
    expect(findOrphans(merge(decoy, unlabeled), { commonDir: REPO, exists }).projects).toEqual([]);
  });

  it('keeps a project while anything of it belongs to a live checkout', () => {
    const shared = merge(project('p', GONE), {
      // a container started for the same project from a live checkout, without our labels
      containers: [r({ id: 'p-c2', project: 'p', workingDir: LIVE })],
      volumes: [],
      networks: [],
    });
    expect(findOrphans(shared, { commonDir: REPO, exists }).projects).toEqual([]);
    // a labeled volume of the project whose checkout still exists
    const volume = merge(project('q', GONE), {
      containers: [],
      volumes: [r({ id: 'q_other', project: 'q', commonDir: REPO, root: LIVE })],
      networks: [],
    });
    expect(findOrphans(volume, { commonDir: REPO, exists }).projects).toEqual([]);
  });

  it('counts a checkout it cannot name as live', () => {
    const unknown = project('u', '');
    expect(findOrphans(unknown, { commonDir: REPO, exists }).projects).toEqual([]);
    // outside a git checkout there is no repository to match
    expect(findOrphans(project('g', GONE), { commonDir: undefined, exists }).projects).toEqual([]);
  });

  it('takes the unlabeled volume of an orphaned project too (made before the labels)', () => {
    const old = merge(project('gone-1', GONE), {
      containers: [],
      volumes: [r({ id: 'gone-1_old', project: 'gone-1' })],
      networks: [],
    });
    expect(findOrphans(old, { commonDir: REPO, exists }).volumes).toEqual([
      'gone-1_pgdata',
      'gone-1_old',
    ]);
  });
});

describe('parseListing', () => {
  it('reads one resource per line of tab-separated JSON strings, whatever the values hold', () => {
    const odd = '/tmp/a\tb\nc'; // a tab and a newline in a label value stay inside its JSON string
    // in the order `list` asks for them: the id, then LABELS' values
    const line = ['abc', REPO, odd, 'proj', ''].map((v) => JSON.stringify(v)).join('\t');
    expect(parseListing(`${line}\n${line}\n`)).toEqual(
      Array.from({ length: 2 }, () => ({
        id: 'abc',
        commonDir: REPO,
        root: odd,
        project: 'proj',
        workingDir: '',
      })),
    );
  });
});

describe('describePruned', () => {
  it('says how much it removed, per deleted checkout, and nothing when nothing went', () => {
    expect(
      describePruned({
        projects: [{ project: 'gone-1', root: GONE }],
        containers: ['c'],
        volumes: ['v', 'w'],
        networks: [],
      }),
    ).toEqual([`removed 1 container, 2 volumes of deleted checkouts:`, `  gone-1 (${GONE})`]);
    expect(describePruned({ projects: [], containers: [], volumes: [], networks: [] })).toEqual([]);
  });
});

// The real thing: labeled volumes and networks (no image needed) in a fake repository, a decoy
// repository's and a live checkout's next to them.
const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });
describe.runIf(docker('info', '--format', '{{.ID}}').status === 0)('pruneOrphans', () => {
  const id = randomBytes(4).toString('hex');
  const repo = join(tmp, `repo-${id}`, '.git'); // never a real repository's common dir
  const live = tmp; // exists
  const gone = join(tmp, 'deleted-worktree');
  const made: [string, string][] = [];
  const create = (kind: 'volume' | 'network', name: string, labels: Record<string, string>) => {
    const flags = Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
    const res = docker(kind, 'create', ...flags, name);
    expect(res.status, res.stderr).toBe(0);
    made.push([kind, name]);
  };
  afterAll(() => {
    for (const [kind, name] of made) docker(kind, 'rm', name);
  });

  it('removes only this repository’s leftovers of deleted checkouts', () => {
    const labels = (name: string, root: string, commonDir = repo) => ({
      [LABELS.project]: name,
      [LABELS.commonDir]: commonDir,
      [LABELS.root]: root,
    });
    create('volume', `orphans-test-gone-${id}_pgdata`, labels(`orphans-test-gone-${id}`, gone));
    create('network', `orphans-test-gone-${id}_default`, {
      [LABELS.project]: `orphans-test-gone-${id}`,
    });
    create('volume', `orphans-test-live-${id}_pgdata`, labels(`orphans-test-live-${id}`, live));
    // a decoy: another repository's project with a similar name, its checkout gone too
    const decoy = `orphans-test-gone-${id}-decoy`;
    create('volume', `${decoy}_pgdata`, labels(decoy, gone, join(tmp, 'other', '.git')));

    const pruned = pruneOrphans({ commonDir: repo });
    expect(pruned).toEqual({
      projects: [{ project: `orphans-test-gone-${id}`, root: gone }],
      containers: [],
      volumes: [`orphans-test-gone-${id}_pgdata`],
      networks: [`orphans-test-gone-${id}_default`],
      failed: [],
    });
    const left = (kind: string) =>
      docker(kind, 'ls', '--format', '{{.Name}}')
        .stdout.split('\n')
        .filter((n) => n.includes(id));
    expect(left('volume').toSorted((a, b) => a.localeCompare(b))).toEqual([
      `${decoy}_pgdata`,
      `orphans-test-live-${id}_pgdata`,
    ]);
    expect(left('network')).toEqual([]);
    // nothing left to do the second time
    expect(pruneOrphans({ commonDir: repo }).projects).toEqual([]);
  });
});
