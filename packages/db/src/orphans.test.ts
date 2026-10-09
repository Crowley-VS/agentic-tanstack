// scripts/orphans.mjs: which Docker resources are leftovers of this repository's deleted
// checkouts (pure), and removing them from a real Docker (resources labeled with a commonDir no
// real checkout has, so nothing else on the machine is ever a candidate).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script
import * as orphans from '../scripts/orphans.mjs';

const { describePruned, findOrphanImages, findOrphans, LABELS, parseListing, pruneOrphans } =
  orphans;
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

describe('findOrphanImages', () => {
  it('finds this repository’s images whose checkout is gone, by their own labels', () => {
    const image = (id: string, root: string, commonDir = REPO) => ({
      id,
      refs: [id],
      project: 'p',
      workingDir: '',
      commonDir,
      root,
    });
    const images = [
      image('gone', GONE),
      image('live', LIVE),
      image('unknown', ''), // a checkout it cannot name counts as live
      image('decoy', GONE, '/elsewhere/app/.git'), // another repository's
    ];
    const found: { id: string }[] = findOrphanImages(images, { commonDir: REPO, exists });
    expect(found.map((i) => i.id)).toEqual(['gone']);
    expect(findOrphanImages(images, { commonDir: undefined, exists })).toEqual([]);
    // a project a live checkout's container keeps (findOrphans): its images stay with it
    expect(findOrphanImages(images, { commonDir: REPO, exists, live: new Set(['p']) })).toEqual([]);
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
    // a stack's images alone (it was built, never started)
    expect(
      describePruned({
        projects: [{ project: 'gone-1-stack', root: GONE }],
        containers: [],
        volumes: [],
        networks: [],
        images: ['a', 'b', 'c'],
      }),
    ).toEqual([`removed 3 images of deleted checkouts:`, `  gone-1-stack (${GONE})`]);
  });
});

// The real thing: labeled volumes, networks and images (built `FROM scratch`: nothing to pull) in
// a fake repository, a decoy repository's and a live checkout's next to them.
const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });
describe.runIf(docker('info', '--format', '{{.ID}}').status === 0)('pruneOrphans', () => {
  const id = randomBytes(4).toString('hex');
  const repo = join(tmp, `repo-${id}`, '.git'); // never a real repository's common dir
  const live = tmp; // exists
  const gone = join(tmp, 'deleted-worktree');
  const made: [string, string][] = [];
  const flags = (labels: Record<string, string>) =>
    Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
  const create = (kind: 'volume' | 'network', name: string, labels: Record<string, string>) => {
    const res = docker(kind, 'create', ...flags(labels), name);
    expect(res.status, res.stderr).toBe(0);
    made.push([kind, name]);
  };
  /** An image of one empty file, so each build is its own image; untagged without `tag`. */
  const build = (labels: Record<string, string>, tag?: string) => {
    const dir = mkdtempSync(join(tmp, 'image-'));
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\nCOPY id /id\n');
    writeFileSync(join(dir, 'id'), randomBytes(8).toString('hex'));
    const res = spawnSync(
      'docker',
      ['build', '--quiet', ...flags(labels), ...(tag ? ['--tag', tag] : []), dir],
      { encoding: 'utf8' },
    );
    expect(res.status, res.stderr).toBe(0);
    const id = res.stdout.trim();
    made.push(['image', tag ?? id]);
    return id;
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
      images: [],
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

  it('removes the images of a deleted checkout’s stack, tagged or not, and keeps the others', () => {
    const labels = (project: string, root: string, commonDir = repo) => ({
      [LABELS.project]: project,
      [LABELS.commonDir]: commonDir,
      [LABELS.root]: root,
    });
    const gone1 = `orphans-test-gone-${id}-stack`;
    build(labels(gone1, gone), `${gone1}-api`);
    build(labels(gone1, gone)); // an earlier build: untagged
    const live1 = `orphans-test-live-${id}-stack`;
    build(labels(live1, live), `${live1}-web`);
    const decoy = `orphans-test-gone-${id}-decoy-stack`;
    build(labels(decoy, gone, join(tmp, 'other', '.git')), `${decoy}-web`);

    const pruned = pruneOrphans({ commonDir: repo });
    expect(pruned.failed).toEqual([]);
    expect(pruned.projects).toEqual([{ project: gone1, root: gone }]);
    expect(pruned.images).toHaveLength(2);
    const left = docker(
      'image',
      'ls',
      '--all',
      '--format',
      '{{.Repository}}',
      '--filter',
      `label=${LABELS.root}`,
    )
      .stdout.split('\n')
      .filter((name) => name.includes(id))
      .toSorted((a, b) => a.localeCompare(b));
    expect(left).toEqual([`${decoy}-web`, `${live1}-web`]);
    const untagged = docker(
      'image',
      'ls',
      '--all',
      '--quiet',
      '--filter',
      `label=${LABELS.commonDir}=${repo}`,
      '--filter',
      'dangling=true',
    );
    expect(untagged.stdout.trim()).toBe('');
  });
});
