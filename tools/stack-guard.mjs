#!/usr/bin/env node
// `node tools/stack-guard.mjs`: exits 1 unless this checkout owns the stack project its stack
// commands would use (dev-ports' `ownsStackProject`). The image builds (`api:docker-build`,
// `web:docker-build`) and `web-e2e:stack-up` run it first, so none of them builds, tags or starts a
// project that STACK_PROJECT or COMPOSE_PROJECT_NAME name after another checkout's stack: the
// images would carry that stack's names and no cleanup of this checkout would remove them.
// CI's docker job owns the project it names (docs/deployment.md).
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInfo } from './dev-ports.mjs';

/** Whether this checkout may build and run `info.stackProject`, and why not. */
export function stackGuard(info) {
  if (info.ownsStackProject) return { ok: true };
  return {
    ok: false,
    message: `[stack] ${info.stackProject} is not this checkout’s own stack (STACK_PROJECT or COMPOSE_PROJECT_NAME name another): unset them to build and run this checkout's stack (docs/deployment.md)`,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = stackGuard(resolveInfo());
  if (!result.ok) {
    console.error(result.message);
    process.exitCode = 1;
  }
}
