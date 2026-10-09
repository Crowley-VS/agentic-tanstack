#!/usr/bin/env node
// Remove this checkout's production-image stack (docker-compose.stack.yml, which
// `pnpm nx run web-e2e:stack-up` builds and starts): its containers, data, network and images, and
// the images earlier builds of it left untagged. `pnpm nx run web-e2e:stack-down` runs it, and so
// does `pnpm teardown`, without Nx (no project graph to compute, no daemon to start).
//
// Idempotent, and it succeeds when Docker is not running. It leaves a stack project that is not
// this checkout's own (STACK_PROJECT or COMPOSE_PROJECT_NAME naming another one: `ownsStackProject`
// in tools/dev-ports.mjs), the way `db-up down` leaves such a dev database: another checkout may
// use it, and `pnpm teardown` runs in every checkout.
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInfo, toEnv } from './dev-ports.mjs';

/** Pure: the `docker` commands that remove the stack of `info` (dev-ports), or why there are none. */
export function stackDownCommands(info) {
  const project = info.stackProject;
  if (!info.ownsStackProject)
    return {
      skip: `${project} is not this checkout’s own stack (STACK_PROJECT or COMPOSE_PROJECT_NAME): another checkout may use it, so it stays (\`docker compose -p ${project} -f docker-compose.stack.yml down --volumes --rmi local\` removes it)`,
    };
  // the labels docker-compose.stack.yml puts on its images (toEnv): a rebuild moves the tag and
  // leaves the previous image untagged, which `down --rmi local` no longer names
  const labels = [`dev-checkout.root=${info.root}`];
  if (info.commonDir) labels.push(`dev-checkout.git-common-dir=${info.commonDir}`);
  const file = join(info.root, 'docker-compose.stack.yml');
  return {
    commands: [
      [
        'compose',
        '-p',
        project,
        '-f',
        file,
        'down',
        '--volumes',
        '--rmi',
        'local',
        '--remove-orphans',
      ],
      ['image', 'prune', '--force', ...labels.flatMap((label) => ['--filter', `label=${label}`])],
    ],
  };
}

/** Docker is missing or its daemon is not running (from a failed docker call's result). */
function noDocker(res) {
  return (
    res.error?.code === 'ENOENT' ||
    /Cannot connect to the Docker daemon|Is the docker daemon running/i.test(res.stderr ?? '')
  );
}

function main() {
  const info = resolveInfo();
  const { skip, commands } = stackDownCommands(info);
  if (skip) {
    console.log(`[stack-down] ${skip}`);
    return;
  }
  const env = { ...toEnv(info), ...process.env };
  for (const args of commands) {
    const res = spawnSync('docker', args, { env, encoding: 'utf8', stdio: 'pipe' });
    if (noDocker(res)) {
      console.log(`[stack-down] Docker is not running: no stack to remove (${info.stackProject})`);
      return;
    }
    // compose reports what it removed on stderr; `image prune` only matters when it removed some
    if (args[0] === 'compose') process.stdout.write(res.stdout ?? '');
    else if (/^deleted:/m.test(res.stdout ?? ''))
      console.log('[stack-down] removed untagged images of earlier builds');
    process.stderr.write(res.stderr ?? '');
    if (res.status !== 0) {
      process.exitCode = res.status ?? 1;
      return;
    }
  }
}

/** Whether process `pid` still runs (EPERM: it does, as another user's). */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * `--after <pid> --unless <file>`: wait until process `pid` has exited, then remove the stack,
 * unless `file` exists (that process removed the stack itself and left the file; it is deleted
 * here). tools/e2e-stack.mjs starts this outside its own process tree: Ctrl-C on
 * `pnpm nx run web-e2e:e2e-stack` makes Nx kill the whole task tree before the script's own last
 * step, and the stack would keep running.
 */
async function after(pid, marker) {
  const deadline = Date.now() + 24 * 60 * 60 * 1000;
  while (alive(pid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 500));
  if (existsSync(marker)) {
    rmSync(marker, { force: true });
    return;
  }
  main();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, pid, unless, marker] = process.argv.slice(2);
  if (flag === '--after' && unless === '--unless' && pid && marker)
    await after(Number(pid), marker);
  else main();
}
