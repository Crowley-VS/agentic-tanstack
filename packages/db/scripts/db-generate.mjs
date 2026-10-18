#!/usr/bin/env node
// `pnpm db:generate <name>`: a new migration in packages/db/migrations from the schema
// (drizzle-kit generate). Safe to allow without a prompt (`Bash(pnpm db:generate *)`):
//
//   pnpm db:generate <name> [--custom] [--output json|text] [--explain] [--hints-file <file>]
//
// The db project's `db-generate` target runs `drizzle-kit generate` as an nx:run-commands string,
// so its `--args="…"` reach a shell, and an allow rule for it would allow any command. pnpm hands a
// root script its arguments one quoted word each; this script checks every one of them before
// anything runs, then starts drizzle-kit with an argv array and no shell, in packages/db.
//
// It does not go through Nx: a run-commands target would put the arguments into a shell string
// again, and `drizzle-kit generate` gains nothing from Nx (no cache, no project graph; the working
// directory is set here). `pnpm regen` still runs the `db:db-generate` target, without a name.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** packages/db: drizzle-kit reads drizzle.config.ts from here. */
export const DB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The repo root: where pnpm runs root scripts, and where a --hints-file must be. */
export const REPO = resolve(DB_DIR, '../..');
/** A migration name: what drizzle-kit appends to the timestamp of the migration's folder. */
export const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SYNOPSIS =
  'usage: pnpm db:generate <name> [--custom] [--output json|text] [--explain] [--hints-file <file>]';
export const USAGE = `Usage: pnpm db:generate <name> [options]

Generates packages/db/migrations/<timestamp>_<name>/ from the schema in packages/db/src/schema.
<name>: letters, digits, _ and - (at most 64, e.g. add_tags), the only argument without --.

Options:
  --custom             an empty migration.sql for your own SQL (a backfill)
  --output json|text   drizzle-kit's output: json prints one JSON envelope (always non-interactive)
  --explain            a dry run: print the planned SQL, write nothing
  --hints-file <file>  answers to drizzle-kit's missing_hints: a .json file in the repo
                       (relative to the repo root, e.g. .agents/ignore/hints.json)
  -h, --help           print this help`;

export class UsageError extends Error {}

/**
 * The options of `argv` (the script's arguments), or a UsageError naming the first one that is
 * not allowed. `cwd` resolves a relative --hints-file (pnpm runs root scripts in the repo root);
 * `root` is the directory it must be in.
 */
export function parseArgs(argv, { cwd = process.cwd(), root = REPO } = {}) {
  const opts = { name: undefined, custom: false, explain: false, output: undefined };
  const seen = new Set();
  const args = argv[0] === '--' ? argv.slice(1) : [...argv]; // `pnpm db:generate -- …` habit
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const [flag, inline] = arg.startsWith('--') ? splitFlag(arg) : [arg, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      const next = args[++i];
      if (next === undefined || next.startsWith('-')) throw new UsageError(`${flag} needs a value`);
      return next;
    };
    if (flag.startsWith('-') && flag !== '-h' && seen.has(flag))
      throw new UsageError(`${flag} is given twice`);
    seen.add(flag);
    switch (flag) {
      case '-h':
      case '--help':
        return { help: true };
      case '--custom':
      case '--explain':
        if (inline !== undefined) throw new UsageError(`${flag} takes no value`);
        opts[flag.slice(2)] = true;
        break;
      case '--output': {
        const output = value();
        if (output !== 'json' && output !== 'text')
          throw new UsageError(`--output is json or text, not ${JSON.stringify(output)}`);
        opts.output = output;
        break;
      }
      case '--hints-file':
        opts.hintsFile = hintsFile(resolve(cwd, value()), root);
        break;
      case '--name':
        throw new UsageError('pass the name as the only argument: pnpm db:generate <name>');
      default:
        if (arg.startsWith('-'))
          throw new UsageError(
            `${JSON.stringify(arg)} is not an option of pnpm db:generate (drizzle.config.ts sets the rest)`,
          );
        if (opts.name !== undefined)
          throw new UsageError(
            `one name only: got ${JSON.stringify(opts.name)} and ${JSON.stringify(arg)}`,
          );
        if (!NAME.test(arg))
          throw new UsageError(
            `invalid migration name ${JSON.stringify(arg)}: use letters, digits, _ and - (at most 64, starting with a letter or digit)`,
          );
        opts.name = arg;
    }
  }
  if (opts.name === undefined) throw new UsageError('missing the migration name');
  return opts;
}

/**
 * The real path of `file`, a hints file: a `.json` file inside `root`, named nothing like
 * `.env*` (a symlink is judged by what it points to too). drizzle-kit prints the start of a file
 * it cannot parse as JSON, so any other file could be read through an allowed command:
 * `--hints-file .env` would get around the `Read(.env)` deny rule.
 */
function hintsFile(file, root) {
  if (!existsSync(file) || !statSync(file).isFile())
    throw new UsageError(`--hints-file: no such file ${JSON.stringify(file)}`);
  const real = realpathSync(file);
  const inside = relative(realpathSync(root), real);
  const refuse = (why) =>
    new UsageError(`--hints-file: ${JSON.stringify(file)} ${why}: give a .json file in the repo`);
  if (inside.split(sep)[0] === '..' || isAbsolute(inside)) throw refuse('is outside the repo');
  for (const name of new Set([basename(file), basename(real)])) {
    if (name.startsWith('.env')) throw refuse(`is an env file (${name})`);
    if (!name.endsWith('.json')) throw refuse(`is not a .json file (${name})`);
  }
  return real;
}

/** `--flag=value` → ['--flag', 'value']; `--flag` → ['--flag', undefined]. */
function splitFlag(arg) {
  const eq = arg.indexOf('=');
  return eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
}

/** drizzle-kit's arguments for the parsed options. */
export function drizzleKitArgs(opts) {
  return [
    'generate',
    '--name',
    opts.name,
    ...(opts.custom ? ['--custom'] : []),
    ...(opts.output ? ['--output', opts.output] : []),
    ...(opts.explain ? ['--explain'] : []),
    ...(opts.hintsFile ? ['--hints-file', opts.hintsFile] : []),
  ];
}

/** `[node, drizzle-kit's bin]` installed in packages/db, or undefined before `pnpm install`. */
export function drizzleKitBin(dir = DB_DIR) {
  const pkgDir = join(dir, 'node_modules', 'drizzle-kit');
  try {
    const { bin } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    const entry = typeof bin === 'string' ? bin : bin?.['drizzle-kit'];
    return entry && existsSync(join(pkgDir, entry))
      ? [process.execPath, join(pkgDir, entry)]
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check `argv`, then run drizzle-kit (`[command, ...args]`) in `cwd`. Returns the exit code:
 * drizzle-kit's (0 ok or no changes, 2 missing hints, …), or 2 for arguments it refused.
 * `argsCwd` and `argsRoot`: parseArgs' `cwd` and `root`.
 */
export function main(
  argv,
  {
    cwd = DB_DIR,
    drizzleKit = drizzleKitBin(),
    argsCwd = process.cwd(),
    argsRoot = REPO,
    stdio = 'inherit',
  } = {},
) {
  let opts;
  try {
    opts = parseArgs(argv, { cwd: argsCwd, root: argsRoot });
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`✗ db:generate: ${err.message}\n  ${SYNOPSIS} (--help for more)`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (!drizzleKit) {
    console.error('✗ db:generate: drizzle-kit is not installed: run `pnpm install`');
    return 1;
  }
  const [cmd, ...pre] = drizzleKit;
  const args = drizzleKitArgs(opts);
  // stderr: with --output json, stdout carries only drizzle-kit's envelope
  console.error(`db:generate: drizzle-kit ${args.join(' ')} (in ${cwd})`);
  const res = spawnSync(cmd, [...pre, ...args], { cwd, stdio, shell: false });
  if (res.error) {
    console.error(`✗ db:generate: could not start drizzle-kit: ${res.error.message}`);
    return 1;
  }
  return res.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
