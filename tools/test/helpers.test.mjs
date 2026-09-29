import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { commitAll, HERMETIC_GIT_ENV, makeRepo, tempDir, writeFile } from './helpers.mjs';

describe('test repos', () => {
  it("ignore the developer's global git config, such as commit signing", () => {
    const hostile = writeFile(
      tempDir(),
      'gitconfig',
      '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n',
    );
    const root = makeRepo({ 'a.txt': 'x' });
    execFileSync('git', ['add', '-A'], { cwd: root });
    // What a signing-enabled global config does to a plain commit in a temp repo:
    const signed = spawnSync('git', ['commit', '-q', '-m', 'signed'], {
      cwd: root,
      env: { ...process.env, GIT_CONFIG_GLOBAL: hostile },
    });
    expect(signed.status).not.toBe(0);

    // Every git process the tests start inherits the hermetic environment instead.
    expect(process.env).toMatchObject(HERMETIC_GIT_ENV);
    commitAll(root);
    expect(
      execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' }),
    ).toBe('1\n');
  });
});
