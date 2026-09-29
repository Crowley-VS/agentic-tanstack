import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeBin } from '../lib/bin.mjs';
import { tempDir, writeFile } from './helpers.mjs';

const REPO = resolve(import.meta.dirname, '../..');

describe('nodeBin', () => {
  it.each(['oxfmt', 'oxlint', 'lefthook'])(
    'runs %s from its JS entry with this Node (no .bin shim, which Windows cannot spawn)',
    (pkg) => {
      const bin = nodeBin(REPO, pkg);
      expect(bin?.[0]).toBe(process.execPath);
      expect(bin?.[1]).not.toContain('.bin');
      const [cmd = '', ...args] = bin ?? [];
      const res = spawnSync(cmd, [...args, '--version'], { encoding: 'utf8' });
      expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
    },
  );

  it('finds a named bin and reports a missing package or bin as undefined', () => {
    const root = tempDir();
    writeFile(root, 'node_modules/tool/package.json', { bin: { other: 'x.js', tool: 't.js' } });
    writeFile(root, 'node_modules/tool/t.js', '');
    expect(nodeBin(root, 'tool')?.[1]).toMatch(/node_modules[\\/]tool[\\/]t\.js$/);
    expect(nodeBin(root, 'tool', 'other')).toBeUndefined(); // listed, but the file is missing
    expect(nodeBin(root, 'missing')).toBeUndefined();
  });
});
