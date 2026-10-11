// scripts/db-generate.mjs (`pnpm db:generate`): it checks every argument before anything runs, and
// hands drizzle-kit an argv array with no shell. The real drizzle-kit runs here in a temp project
// with its own schema and migrations folder, never in packages/db.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DB_DIR,
  drizzleKitArgs,
  drizzleKitBin,
  main,
  parseArgs,
  UsageError,
  // @ts-expect-error plain .mjs script
} from '../scripts/db-generate.mjs';

const REPO = join(DB_DIR, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'db-generate-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const HINTS = join(tmp, 'hints.json');
writeFileSync(HINTS, '[]');

beforeEach(() => {
  // main() reports on stderr what it runs or refuses
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('parseArgs', () => {
  it('takes one name and the options drizzle-kit needs here', () => {
    expect(parseArgs(['add_tags'])).toEqual({
      name: 'add_tags',
      custom: false,
      explain: false,
      output: undefined,
    });
    const all = ['--custom', 'Backfill-2', '--output', 'json', '--explain', '--hints-file', HINTS];
    expect(drizzleKitArgs(parseArgs(all))).toEqual([
      'generate',
      '--name',
      'Backfill-2',
      '--custom',
      '--output',
      'json',
      '--explain',
      '--hints-file',
      HINTS,
    ]);
    expect(parseArgs(['x', '--output=text']).output).toBe('text');
    // a relative --hints-file is read from the repo root (where pnpm runs root scripts)
    expect(parseArgs(['x', '--hints-file=hints.json'], { cwd: tmp }).hintsFile).toBe(HINTS);
    // `pnpm db:generate -- x`: pnpm passes the `--` on
    expect(parseArgs(['--', 'x']).name).toBe('x');
    expect(parseArgs(['--help'])).toEqual({ help: true });
  });

  it.each([
    [[], 'missing the migration name'],
    [['a', 'b'], 'one name only: got "a" and "b"'],
    [['x; touch y'], 'invalid migration name "x; touch y"'],
    [['a b'], 'invalid migration name "a b"'],
    [['x"y'], 'invalid migration name "x\\"y"'],
    [['$(id)'], 'invalid migration name "$(id)"'],
    [['../x'], 'invalid migration name "../x"'],
    [['_x'], 'invalid migration name "_x"'],
    [['x'.repeat(65)], 'invalid migration name'],
    [['--name=x'], 'pass the name as the only argument'],
    [['x', '--config', 'other.ts'], '"--config" is not an option'],
    [['x', '--out=elsewhere'], '"--out=elsewhere" is not an option'],
    [['x', '--hints', '[]'], '"--hints" is not an option'],
    [['x', '-y'], '"-y" is not an option'],
    [['x', '--output', 'yaml'], '--output is json or text, not "yaml"'],
    [['x', '--output'], '--output needs a value'],
    [['x', '--output', '--explain'], '--output needs a value'],
    [['x', '--hints-file', join(tmp, 'missing.json')], '--hints-file: no such file'],
    [['x', '--hints-file', tmp], '--hints-file: no such file'],
    [['x', '--custom', '--custom'], '--custom is given twice'],
    [['x', '--custom=yes'], '--custom takes no value'],
  ])('refuses %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe('main', () => {
  const log = join(tmp, 'fake.log');
  const fake = join(tmp, 'fake-drizzle-kit.mjs');
  writeFileSync(
    fake,
    `import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, cwd: process.cwd() }));
process.exit(argv.includes('exit_3') ? 3 : 0);
`,
  );
  const run = (argv: string[]) => {
    rmSync(log, { force: true });
    const status = main(argv, { cwd: tmp, drizzleKit: [process.execPath, fake], stdio: 'ignore' });
    return { status, call: existsSync(log) ? JSON.parse(readFileSync(log, 'utf8')) : undefined };
  };

  it('runs drizzle-kit generate in the given directory, each argument as one word', () => {
    expect(run(['add_tags', '--output', 'json', '--hints-file', HINTS])).toEqual({
      status: 0,
      call: {
        argv: ['generate', '--name', 'add_tags', '--output', 'json', '--hints-file', HINTS],
        cwd: tmp,
      },
    });
  });

  it("returns drizzle-kit's exit code", () => {
    expect(run(['exit_3']).status).toBe(3);
  });

  it('runs nothing when an argument is refused, and exits 2', () => {
    expect(run(['x; touch y'])).toEqual({ status: 2, call: undefined });
    expect(run(['x', '--config', 'y.ts'])).toEqual({ status: 2, call: undefined });
  });

  it('runs drizzle-kit from packages/db by default', () => {
    const bin = drizzleKitBin();
    expect(bin?.[0]).toBe(process.execPath);
    expect(bin?.[1]).toContain(join(DB_DIR, 'node_modules', 'drizzle-kit'));
  });
});

// drizzle-kit runs five times here (33s once in CI): far over Vitest's 5s default
describe('the real drizzle-kit (a temp project)', { timeout: 120_000 }, () => {
  const project = join(tmp, 'project');
  mkdirSync(project);
  // packages/db's dependencies: drizzle-kit and the drizzle-orm it checks the schema with
  symlinkSync(join(DB_DIR, 'node_modules'), join(project, 'node_modules'), 'junction');
  writeFileSync(
    join(project, 'drizzle.config.ts'),
    "import { defineConfig } from 'drizzle-kit';\n" +
      "export default defineConfig({ dialect: 'postgresql', schema: './schema.ts', out: './migrations' });\n",
  );
  const schema = (...columns: string[]) =>
    writeFileSync(
      join(project, 'schema.ts'),
      "import { pgTable, text } from 'drizzle-orm/pg-core';\n" +
        `export const things = pgTable('things', { ${columns.map((c) => `${c}: text('${c}')`).join(', ')} });\n`,
    );
  const migrations = () =>
    existsSync(join(project, 'migrations')) ? readdirSync(join(project, 'migrations')) : [];
  const generate = (...argv: string[]) => main(argv, { cwd: project, stdio: 'ignore' });
  const sql = (name: string) => {
    const dir = migrations().find((d) => d.endsWith(`_${name}`));
    return dir ? readFileSync(join(project, 'migrations', dir, 'migration.sql'), 'utf8') : '';
  };

  it('accepts every option this script passes', () => {
    schema('label');
    expect(generate('create_things', '--output', 'json')).toBe(0);
    expect(sql('create_things')).toContain('CREATE TABLE "things"');

    // a dry run writes nothing
    schema('label', 'note');
    expect(generate('dry_run', '--output', 'json', '--explain')).toBe(0);
    expect(migrations()).toHaveLength(1);

    // dropping a column and adding one asks rename-or-create: exit 2, nothing written
    schema('title');
    expect(generate('rename', '--output', 'json')).toBe(2);
    expect(migrations()).toHaveLength(1);
    // the answer, from a file (what skill drizzle-hints reads; db-migration splits such a change)
    const hints = join(tmp, 'create.json');
    writeFileSync(
      hints,
      JSON.stringify([{ type: 'create', kind: 'column', entity: ['public', 'things', 'title'] }]),
    );
    expect(generate('add_title', '--output', 'json', '--hints-file', hints)).toBe(0);
    expect(sql('add_title')).toContain('ADD COLUMN "title"');

    expect(generate('backfill', '--custom')).toBe(0);
    expect(sql('backfill')).toMatch(/^-- Custom SQL migration file/);
  });
});

// pnpm hands a root script its arguments one quoted word each, so the script sees a name with a
// `;`, a space or a quote whole, and refuses it: no shell ever reads it. This is what makes
// `Bash(pnpm db:generate *)` a safe allow rule.
describe('pnpm db:generate (the root script)', { timeout: 30_000 }, () => {
  const marker = join(tmp, 'pwned');
  it.each([
    `x; touch ${marker}`,
    `x && touch ${marker}`,
    `$(touch ${marker})`,
    `\`touch ${marker}\``,
    'a b',
    `x' 'y`,
    'x"y',
  ])('passes %j as one argument, and refuses it', (name) => {
    const res = spawnSync('pnpm', ['db:generate', name], { cwd: REPO, encoding: 'utf8' });
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(2);
    expect(res.stderr).toContain(`invalid migration name ${JSON.stringify(name)}`);
    expect(existsSync(marker)).toBe(false);
  });
});
