#!/usr/bin/env node
// `pnpm nx run web-e2e:e2e-stack`: every e2e spec against the production images, in one command
// (docs/deployment.md). Nx builds both images first (the docker-build targets); then, on this
// checkout's stack (docker-compose.stack.yml, `-p $STACK_PROJECT`), this script
//
//   1. starts it with the write rate limit off (the specs write dozens of notes) and waits until
//      every service is healthy: the api image migrates the empty database on the way;
//   2. seeds its database from here (`db:db-seed` on the db's loopback port): no dev-only code
//      goes into an image;
//   3. runs the migrations again, as every deploy does: they must find nothing to do and keep the
//      rows (seed.spec reads them next);
//   4. runs every spec against it (`web-e2e:e2e-base-url`; arguments after `--` go to Playwright)
//      with the seed required (E2E_REQUIRE_STACK=1): none skips for want of it;
//   5. removes it (tools/stack-down.mjs), whatever happened before.
//
// CI's `docker` job runs the same steps (.github/workflows/ci.yml) and checks the running images
// on top. Like stack-down, it refuses a stack project that is not this checkout's own.
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInfo, toEnv } from './dev-ports.mjs';
import { SHELL_ON_WINDOWS } from './lib/bin.mjs';

const log = (message) => console.log(`[e2e-stack] ${message}`);

/**
 * Run the steps above for `info` (dev-ports) with `run(command, args, env, capture)`, which
 * returns spawnSync's result (`status`, and `stdout` when `capture`). Returns the exit code: the
 * first failed step's, else stack-down's.
 */
export function e2eStack(info, baseEnv, run, playwrightArgs = []) {
  if (!info.ownsStackProject) {
    log(
      `${info.stackProject} is not this checkout’s own stack (STACK_PROJECT or COMPOSE_PROJECT_NAME): unset them, or run stack-up and e2e-base-url yourself (docs/deployment.md)`,
    );
    return 1;
  }
  const env = { ...toEnv(info), ...baseEnv, STACK_WRITE_RATE_LIMIT: 'off' };
  // The nested Nx runs are runs of their own, not this task: with this task's NX_TASK_* they
  // would evaluate playwright.config.mts as if Playwright ran under e2e-stack
  const nxEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith('NX_TASK_')),
  );
  const file = join(info.root, 'docker-compose.stack.yml');
  const compose = (...args) => ['compose', '-p', info.stackProject, '-f', file, ...args];

  let code = 0;
  /** Runs one step unless an earlier one failed; returns its result. */
  const step = (name, command, args, { stepEnv = env, capture = false } = {}) => {
    if (code !== 0) return undefined;
    log(name);
    const result = run(command, args, stepEnv, capture);
    code = result.status ?? 1;
    if (code !== 0) log(`${name}: failed (exit code ${code})`);
    return result;
  };

  step('start the stack', 'docker', compose('up', '--detach', '--wait'));
  const db = step('find the database port', 'docker', compose('port', 'db', '5432'), {
    capture: true,
  })?.stdout?.trim(); // 127.0.0.1:<the port Docker picked>
  if (code === 0 && !db) code = 1;
  step('seed the database', 'pnpm', ['nx', 'run', 'db:db-seed', '--excludeTaskDependencies'], {
    stepEnv: { ...nxEnv, DATABASE_URL: `postgresql://app:app@${db}/app` },
  });
  step('migrate again, as a redeploy does', 'docker', compose('run', '--rm', '-T', 'migrate'));
  const forward = playwrightArgs.length > 0 ? ['--', ...playwrightArgs] : [];
  step('every spec against the stack', 'pnpm', ['nx', 'run', 'web-e2e:e2e-base-url', ...forward], {
    stepEnv: { ...nxEnv, BASE_URL: info.urls.stack, E2E_SEEDED: '1', E2E_REQUIRE_STACK: '1' },
  });

  log('remove the stack');
  const down = run(process.execPath, [join(info.root, 'tools', 'stack-down.mjs')], env, false);
  return code || (down.status ?? 1);
}

/** e2eStack's runner: the command's output goes to the terminal, unless captured. */
function spawnStep(command, args, env, capture) {
  return spawnSync(command, args, {
    env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    ...(command === 'pnpm' ? SHELL_ON_WINDOWS : {}),
  });
}

function main(argv) {
  // Nx passes the target's extra arguments on as they are, after a `--` or not
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  process.exitCode = e2eStack(resolveInfo(), process.env, spawnStep, args);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
