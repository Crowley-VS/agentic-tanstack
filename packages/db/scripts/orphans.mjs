// Docker leftovers of this repository's deleted checkouts: the Postgres container, volume and
// network of a worktree whose directory is gone (an agent's worktree removed under a running
// database, or after `pnpm teardown` kept its volume), and its production-image stack
// (docker-compose.stack.yml: containers, network and the images it built). Run by
// `pnpm prune:orphans`, and by db-up whenever it has to call Docker anyway (never on its fast
// path).
//
// Ours, precisely: docker-compose.yml labels the container and the volume with the repository's
// git common dir (shared by all its worktrees) and the checkout's directory, and
// docker-compose.stack.yml its containers and images. A compose project is an orphan when every
// labeled resource of it names a checkout directory that no longer exists and no container of it
// runs from a directory that still does. A project that belongs to a process rather than to a
// checkout (a test's, in a temp directory that outlives a killed run) also carries
// `dev-checkout.owner`, `<pid>@<host name>`: it is an orphan once that process has exited, whether
// or not its directories still exist. An image goes on its own labels (findOrphanImages).
// Docker's own label filter picks the candidates, and findOrphans checks the label again: other
// repositories' resources and live checkouts' are never touched, and unlabeled ones only as part
// of an orphaned project.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';

export const LABELS = {
  commonDir: 'dev-checkout.git-common-dir',
  root: 'dev-checkout.root',
  project: 'com.docker.compose.project',
  workingDir: 'com.docker.compose.project.working_dir',
  owner: 'dev-checkout.owner',
};
const KINDS = {
  containers: ['container', 'ls', '-a', '--no-trunc'],
  volumes: ['volume', 'ls'],
  networks: ['network', 'ls', '--no-trunc'],
};

/**
 * Parse a `docker <kind> ls --format` listing made by `list`: one line per resource, tab-separated
 * JSON strings (a label value cannot break the line apart).
 */
export function parseListing(stdout) {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, ...labels] = line.split('\t').map((field) => JSON.parse(field));
      return Object.fromEntries([
        ['id', id],
        ...Object.keys(LABELS).map((key, i) => [key, labels[i] ?? '']),
      ]);
    });
}

/** True while process `pid` runs (EPERM: it runs as another user). */
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * True unless `owner` (an owner label's value, `<pid>@<host name>`) names a process of this
 * machine that has exited. Another host's process (a container's: its own pids, its own host
 * name) and a value that is no owner count as running: not ours to judge.
 */
export function ownerRunning(owner, host = hostname()) {
  const [, pid, on] = /^(\d+)@(.+)$/.exec(owner) ?? [];
  return !pid || on !== host || alive(Number(pid));
}

/**
 * A labeled resource (or image) whose checkout is gone: the process its owner label names has
 * exited, or, without one, the directory its root label names no longer exists (no root: an
 * unknown checkout, which counts as live).
 */
const checkoutGone = (r, { exists, running }) =>
  r.owner ? !running(r.owner) : Boolean(r.root) && !exists(r.root);

/**
 * Pure: the compose projects of this repository (`commonDir`) whose checkouts are gone, and their
 * containers, volumes and networks. `exists(dir)` tells whether a directory exists, and
 * `running(owner)` whether an owner label's process runs (ownerRunning).
 */
export function findOrphans(
  { containers, volumes, networks },
  { commonDir, exists, running = ownerRunning },
) {
  const none = { projects: [], containers: [], volumes: [], networks: [] };
  if (!commonDir) return none;
  const ours = [...containers, ...volumes].filter((r) => r.commonDir === commonDir && r.project);
  const projects = new Map(); // project -> its checkout directory, or null once one is live
  for (const r of ours) {
    const live = !checkoutGone(r, { exists, running });
    projects.set(r.project, live || projects.get(r.project) === null ? null : r.root);
  }
  // a container started from a directory that still exists (with or without our labels) is live,
  // unless it names its owner: then that process alone decides
  for (const c of containers)
    if (
      projects.has(c.project) &&
      (c.owner ? running(c.owner) : !c.workingDir || exists(c.workingDir))
    )
      projects.set(c.project, null);
  const gone = new Map([...projects].filter(([, root]) => root !== null));
  if (gone.size === 0) return none;
  const of = (resources) => resources.filter((r) => gone.has(r.project)).map((r) => r.id);
  return {
    projects: [...gone].map(([project, root]) => ({ project, root })),
    containers: of(containers),
    volumes: of(volumes),
    networks: of(networks),
  };
}

/**
 * Pure: this repository's images (`commonDir`) whose checkout directory is gone, by their own
 * labels: a stack's images may outlive its containers (built alone, or after a `down` that kept
 * them). Not those of a `live` compose project, one whose containers or volumes findOrphans keeps.
 */
export function findOrphanImages(
  images,
  { commonDir, exists, running = ownerRunning, live = new Set() },
) {
  if (!commonDir) return [];
  return images.filter(
    (image) =>
      image.commonDir === commonDir &&
      checkoutGone(image, { exists, running }) &&
      !live.has(image.project),
  );
}

function docker(args, env) {
  const res = spawnSync('docker', args, {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.error || res.status !== 0)
    throw Object.assign(
      new Error(
        res.error?.code === 'ENOENT'
          ? 'Docker is not installed'
          : `docker ${args.slice(0, 2).join(' ')} failed: ${(res.stderr ?? '').trim() || res.error}`,
      ),
      { docker: true, stderr: res.stderr },
    );
  return res.stdout;
}

/** True while Docker has the `kind` (container, network, volume, image) named `id`. */
const present = (kind, id, env) =>
  spawnSync('docker', [kind, 'inspect', id], { env, stdio: 'ignore' }).status === 0;

/** Wait `ms`, blocking (pruneOrphans is synchronous). */
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The resources of one kind that carry `label` (`key` or `key=value`), with the labels we read. */
function list(kind, label, env) {
  const fields = [
    kind === 'containers' ? '.ID' : '.Name',
    ...Object.values(LABELS).map((l) => `(.Label "${l}")`),
  ];
  const format = fields.map((field) => `{{json ${field}}}`).join('\t');
  return parseListing(
    docker([...KINDS[kind], '--filter', `label=${label}`, '--format', format], env),
  );
}

/**
 * The images labeled `label` (`key=value`), with their tags (`refs`: the id when it has none) and
 * the labels we read. `docker image ls --format` cannot read labels: `image inspect` does.
 */
function listImages(label, env) {
  const ids = docker(
    ['image', 'ls', '--all', '--no-trunc', '--quiet', '--filter', `label=${label}`],
    env,
  )
    .split('\n')
    .filter(Boolean);
  if (ids.length === 0) return [];
  return JSON.parse(docker(['image', 'inspect', ...new Set(ids)], env)).map((image) => {
    const labels = image.Config?.Labels ?? {};
    return {
      id: image.Id,
      // by name: removing an image by id fails while it has several names
      refs: image.RepoTags?.length ? image.RepoTags : [image.Id],
      ...Object.fromEntries(Object.entries(LABELS).map(([key, l]) => [key, labels[l] ?? ''])),
    };
  });
}

/**
 * Remove this repository's orphaned containers, networks, volumes and images (in that order: a
 * network, volume or image in use cannot go). Returns what findOrphans and findOrphanImages
 * found, plus `failed`: the removals Docker refused of what it still has a moment later. Throws
 * (`err.docker`) when Docker cannot list its resources.
 */
export function pruneOrphans(
  { commonDir },
  { env = process.env, exists = existsSync, running = ownerRunning } = {},
) {
  const failed = [];
  const none = { projects: [], containers: [], volumes: [], networks: [] };
  let candidates = new Set();
  let gone = [];
  if (commonDir) {
    // Docker itself picks the containers, volumes and images labeled with this repository (three
    // calls): only their projects can go, whatever happens below
    const mine = `${LABELS.commonDir}=${commonDir}`;
    const labeled = [...list('containers', mine, env), ...list('volumes', mine, env)];
    candidates = new Set(
      labeled.filter((r) => checkoutGone(r, { exists, running })).map((r) => r.project),
    );
    gone = findOrphanImages(listImages(mine, env), { commonDir, exists, running });
    for (const image of gone) if (image.project) candidates.add(image.project);
  }
  if (candidates.size === 0 && gone.length === 0) return { ...none, images: [], failed };
  // then everything of those projects: a live checkout's container keeps one, unlabeled resources go
  const of = (kind) => list(kind, LABELS.project, env).filter((r) => candidates.has(r.project));
  const [containers, volumes, networks] =
    candidates.size === 0 ? [[], [], []] : [of('containers'), of('volumes'), of('networks')];
  const found = findOrphans({ containers, volumes, networks }, { commonDir, exists, running });
  // a project whose containers or volumes stay is live, and so are its images
  const orphaned = new Set(found.projects.map((p) => p.project));
  const live = new Set(
    [...containers, ...volumes].map((r) => r.project).filter((p) => !orphaned.has(p)),
  );
  const images = findOrphanImages(gone, { commonDir, exists, running, live });
  const remove = (kind, args, ids) => {
    if (ids.length === 0) return;
    try {
      docker([...args, ...ids], env);
    } catch (err) {
      // gone already: another checkout's db-up pruned it at the same time
      const lines = String(err.stderr ?? err.message)
        .split('\n')
        .filter((line) => line.trim() && !/no such (container|volume|image)|not found/i.test(line));
      // or going: another remover has it at this moment (a test's reaper, another prune), and
      // Docker refuses this one in its own words ("already in progress", "active endpoints", or
      // a bare "exit status 1"); what is gone a moment later was no refusal
      for (let i = 0; lines.length && i < 10; i++) {
        if (!ids.some((id) => present(kind, id, env))) return;
        pause(200);
      }
      if (lines.length) failed.push(`docker ${args.join(' ')}: ${lines.join('; ')}`);
    }
  };
  remove('container', ['rm', '--force', '--volumes'], found.containers);
  remove('network', ['network', 'rm'], found.networks);
  remove('volume', ['volume', 'rm'], found.volumes);
  remove(
    'image',
    ['image', 'rm'],
    images.flatMap((image) => image.refs),
  );
  // a stack's images may outlive its containers (built alone, or after `down` without --rmi)
  const projects = [...found.projects];
  for (const { project, root } of images)
    if (project && !projects.some((p) => p.project === project)) projects.push({ project, root });
  return { ...found, projects, images: images.map((image) => image.id), failed };
}

const count = (n, what) => (n ? [`${n} ${what}${n === 1 ? '' : 's'}`] : []);

/** What was removed, then one line per removed project, for the console. */
export function describePruned({ projects, containers, volumes, networks, images = [] }) {
  const total = [
    ...count(containers.length, 'container'),
    ...count(volumes.length, 'volume'),
    ...count(networks.length, 'network'),
    ...count(images.length, 'image'),
  ].join(', ');
  if (!total) return [];
  return [
    `removed ${total} of deleted checkouts:`,
    ...projects.map(({ project, root }) => `  ${project} (${root})`),
  ];
}
