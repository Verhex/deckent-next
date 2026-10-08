import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentTurnWriteFloor, classifySandboxWritePath, createShellWriteContext, createWorkspaceScope, isSelfSourceIdentity, isSelfSourceProject,
  isSelfSourceWriteFloored, isWriteApprovalFloored, resolveSourceCommonDir } from '#adapters/index.js';

const roots: string[] = [];
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'self-source-')); roots.push(root);
  git(root, 'init', '-q'); git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial', '--allow-empty');
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('derived self-source floor', () => {
  it('compares canonical common directories, never missing identities', () => {
    expect(isSelfSourceIdentity('/repo/.git', '/repo/.git')).toBe(true);
    expect(isSelfSourceIdentity('/n1/.git', '/repo/.git')).toBe(false);
    expect(isSelfSourceIdentity('/customer/.git', undefined)).toBe(false);
    expect(isSelfSourceIdentity(null, null)).toBe(false);
    expect(isSelfSourceIdentity('', '')).toBe(false);
  });
  it('recognizes another worktree and symlink of the repository but never a separate clone/customer', async () => {
    const root = await repository(), common = await realpath(join(root, '.git'));
    const worktree = join(root, 'worktree'), clone = join(root, 'clone'), link = join(root, 'link');
    git(root, 'worktree', 'add', '-qb', 'test', worktree); git(root, 'clone', '-q', '--no-hardlinks', root, clone); await symlink(root, link);
    expect(await resolveSourceCommonDir(worktree)).toBe(common);
    expect(await isSelfSourceProject(worktree, { sourceCommonDir: common })).toBe(true);
    expect(await isSelfSourceProject(link, { sourceCommonDir: common })).toBe(true);
    expect(await isSelfSourceProject(clone, { sourceCommonDir: common })).toBe(false);
    expect(await isSelfSourceProject(await repository(), { sourceCommonDir: common })).toBe(false);
    expect(await isSelfSourceProject(root, null)).toBe(false);
    expect(await isSelfSourceProject(root, {})).toBe(false);
    expect(await isSelfSourceProject(join(root, 'missing'), { sourceCommonDir: common })).toBe(false);
  });
  it('keeps full access exactly on the authority callback and customer projects on the static callback', () => {
    const authority = (rel: string) => rel === 'config.json';
    expect(agentTurnWriteFloor(authority, true, true)).toBe(authority);
    expect(agentTurnWriteFloor(authority, true, false)).toBe(authority);
    expect(agentTurnWriteFloor(authority, false, false)).toBe(isWriteApprovalFloored);
    const floor = agentTurnWriteFloor(authority, false, true);
    for (const path of ['src/a.ts', 'dist/main.js', 'scripts/build.mjs', 'assets/icon.png', 'package.json']) expect(floor(path)).toBe(true);
    expect(floor('docs/a.md')).toBe(false);
  });
  it('classifies dist writes/deletes and new floor directories, retaining denied and authority precedence', async () => {
    const scope = await createWorkspaceScope(await repository()), authority = (rel: string) => rel === 'src/config.json';
    for (const kind of ['write', 'delete'] as const) expect(classifySandboxWritePath(scope, authority, 'dist/new.js', kind, true)).toBe('edit-self-source');
    for (const kind of ['mkdir', 'rmdir'] as const) expect(classifySandboxWritePath(scope, authority, 'dist', kind, true)).toBe('edit-self-source');
    expect(classifySandboxWritePath(scope, authority, 'src/config.json', 'write', true)).toBe('edit-authority');
    expect(classifySandboxWritePath(scope, authority, '../dist/x', 'write', true)).toBe('denied');
    expect(classifySandboxWritePath(scope, authority, 'dist/new.js', 'write', false)).toBe('edit');
    expect(classifySandboxWritePath(scope, authority, 'package.json', 'write', false)).toBe('edit-floor');
  });
  it('keeps the static hard floor distinct in self-source repositories, including overlapping paths and directories', async () => {
    const scope = await createWorkspaceScope(await repository()), authority = (rel: string) => rel === '.deckent/config.json';
    for (const path of ['package.json', '.deckent/config.json', '.agents/refactor/x.mjs', '.github/w.yml', 'DECKENT.md', 'AGENTS.md', 'src/package.json']) {
      expect(classifySandboxWritePath(scope, () => false, path, 'write', true), path).toBe('edit-floor');
    }
    for (const path of ['package.json', '.deckent/config.json', '.agents/refactor/x.mjs', '.github/w.yml', 'DECKENT.md', 'AGENTS.md']) {
      expect(isSelfSourceWriteFloored(path), path).toBe(false);
      expect(agentTurnWriteFloor(() => false, false, true)(path), path).toBe(true);
    }
    expect(classifySandboxWritePath(scope, authority, '.deckent/config.json', 'write', true)).toBe('edit-authority');
    for (const path of ['src/a.ts', 'dist/x.js', 'scripts/b.mjs', 'assets/c.json']) {
      expect(classifySandboxWritePath(scope, authority, path, 'write', true), path).toBe('edit-self-source');
    }
    for (const kind of ['mkdir', 'rmdir'] as const) {
      expect(classifySandboxWritePath(scope, authority, 'src', kind, true)).toBe('edit-self-source');
      expect(classifySandboxWritePath(scope, authority, 'src/package.json', kind, true)).toBe('edit-floor');
      expect(classifySandboxWritePath(scope, authority, '.github', kind, true)).toBe('edit-floor');
    }
  });
  it('does not classify self-source shell targets as narrow unattended mutations, scratch stays ordinary', async () => {
    const root = await repository(); await mkdir(join(root, 'dist')); await writeFile(join(root, 'dist/a.js'), 'before');
    const scope = await createWorkspaceScope(root), scratch = await createWorkspaceScope(await repository());
    const writes = createShellWriteContext(scope, [scratch], isSelfSourceWriteFloored);
    if (process.platform !== 'linux' || !existsSync('/proc/self/fd')) {
      expect(await scope.resolve('dist/a.js')).toEqual({ ok: false, error: 'platform-unsupported' });
      expect(await scope.open('dist', 'dir')).toEqual({ ok: false, error: 'platform-unsupported' });
      expect(await writes.checkWrite({ text: 'dist/a.js', quoted: false, glob: false, tilde: false }, 'file')).toMatchObject({ ok: false, reasonCode: 'PATH_UNRESOLVED' });
      expect(await readFile(join(root, 'dist/a.js'), 'utf8')).toBe('before');
      console.log('verify-not-run: ' + JSON.stringify({ file: 'tests/contracts/adapters/self-source-floor.test.ts', test: expect.getState().currentTestName, state: 'skipped', variant: 'descriptor-backed-write-classification', reason: 'WORKSPACE_PLATFORM_UNSUPPORTED: platform-unsupported refusal asserted; Linux descriptor-backed positive remains required' }));
      return;
    }
    expect(await writes.checkWrite({ text: 'dist/a.js', quoted: false, glob: false, tilde: false }, 'file')).toMatchObject({ ok: false, reasonCode: 'PATH_PROTECTED' });
    expect(await createShellWriteContext(scope).checkWrite({ text: 'dist/a.js', quoted: false, glob: false, tilde: false }, 'file')).toEqual({ ok: true });
    expect(await writes.checkWrite({ text: join(scratch.root, 'a.js'), quoted: false, glob: false, tilde: false }, 'file')).toEqual({ ok: true });
  });
});
