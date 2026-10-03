import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Build tooling is native JavaScript, not a product TypeScript module.
import { writeBuildIdentity } from '../../../scripts/build-identity.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'deckent-build-identity-')); roots.push(root);
  mkdirSync(join(root, 'src')); mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  const source = join(root, 'src', 'index.ts'); writeFileSync(source, 'export const value = 1;');
  return { root, source };
}
function git(root: string, args: readonly string[]) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim(); }
function identity(root: string, source: string) {
  return writeBuildIdentity(root, [source], join(root, 'dist'));
}

describe('build sourceCommonDir producer (no build)', () => {
  it('writes the real Git common directory beside the commit in schema v1', () => {
    const { root, source } = fixture(); git(root, ['init', '-q']);
    git(root, ['add', '.']); git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    const built = identity(root, source);
    expect(built.sourceCommonDir).toBe(realpathSync(join(root, '.git')));
    expect(built.sourceCommit).toBe(git(root, ['rev-parse', 'HEAD']));
    expect(built.schemaVersion).toBe(1);
    expect(JSON.parse(readFileSync(join(root, 'dist', 'build-identity.json'), 'utf8'))).toEqual(built);
  });
  it('worktree builds preserve the repository common directory', () => {
    const { root } = fixture(); git(root, ['init', '-q']); git(root, ['add', '.']);
    git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    const worktree = join(root, 'linked'); git(root, ['worktree', 'add', '--detach', '-q', worktree]);
    mkdirSync(join(worktree, 'dist'), { recursive: true });
    expect(identity(worktree, join(worktree, 'src', 'index.ts')).sourceCommonDir).toBe(realpathSync(join(root, '.git')));
  });
  it('canonicalizes a symlinked source checkout', () => {
    const { root } = fixture(); git(root, ['init', '-q']);
    const alias = join(root, 'alias'); symlinkSync(root, alias, 'dir');
    expect(identity(alias, join(alias, 'src', 'index.ts')).sourceCommonDir).toBe(realpathSync(join(root, '.git')));
  });
  it('archive/customer source trees without Git omit the optional field', () => {
    const { root, source } = fixture();
    expect(identity(root, source)).not.toHaveProperty('sourceCommonDir');
    expect(identity(root, source).sourceCommit).toBeNull();
  });
  it.each(['GIT_DIR', 'GIT_COMMON_DIR'])('ignores inherited %s pointing at another repository', variable => {
    const { root, source } = fixture(); const foreign = fixture().root;
    git(root, ['init', '-q']); git(foreign, ['init', '-q']);
    const previous = process.env[variable]; process.env[variable] = join(foreign, '.git');
    try { expect(identity(root, source).sourceCommonDir).toBe(realpathSync(join(root, '.git'))); }
    finally { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; }
  });
});
