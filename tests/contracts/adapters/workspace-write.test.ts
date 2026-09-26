import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ABSENT_FILE_VERSION, WorkspaceFileTarget, createWorkspaceScope, DEFAULT_WORKSPACE_READ_DENY, fileContentVersion, planWorkspaceEdit,
  readWritableFile, resolveWritable } from '#adapters/index.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'dn-write-')); roots.push(root);
  await mkdir(join(root, 'src')); await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
  await writeFile(join(root, '.env'), 'SECRET=1');
  return { root, scope: await createWorkspaceScope(root, DEFAULT_WORKSPACE_READ_DENY), journal: join(root, '..', `${root.split('/').at(-1)}-journal`) };
}
const ref = (id: string) => ({ kind: 'workspace-file', id });

describe.skipIf(process.platform !== 'linux')('workspace write (T-L4 slice 2)', () => {
  it('plans an exact edit as a diff against the current version, and refuses ambiguous, missing and pattern-bearing surprises', async () => {
    const { scope } = await workspace();
    const plan = await planWorkspaceEdit(scope, 'edit_file', { path: 'src/a.ts', old_string: 'const b = 2', new_string: 'const b = 3' });
    expect(plan).toMatchObject({ ok: true, rel: 'src/a.ts', after: 'export const a = 1;\nexport const b = 3;\n', added: 1, removed: 1,
      beforeVersion: fileContentVersion(Buffer.from('export const a = 1;\nexport const b = 2;\n')) });
    expect(plan.ok && plan.preview).toContain('-export const b = 2;\n+export const b = 3;');
    // `$&` and friends are literal text, never replacement patterns (legacy String.replace defect).
    expect(await planWorkspaceEdit(scope, 'edit_file', { path: 'src/a.ts', old_string: '1', new_string: '$&$&' })).toMatchObject({ ok: true, after: 'export const a = $&$&;\nexport const b = 2;\n' });
    expect(await planWorkspaceEdit(scope, 'edit_file', { path: 'src/a.ts', old_string: 'export', new_string: 'x' })).toMatchObject({ ok: false, error: expect.stringMatching(/matches 2 places/) });
    expect(await planWorkspaceEdit(scope, 'edit_file', { path: 'src/a.ts', old_string: 'export', new_string: 'x', replace_all: true })).toMatchObject({ ok: true, after: 'x const a = 1;\nx const b = 2;\n' });
    expect(await planWorkspaceEdit(scope, 'edit_file', { path: 'src/a.ts', old_string: 'nope', new_string: 'x' })).toMatchObject({ ok: false, error: 'old_string not found' });
    expect(await planWorkspaceEdit(scope, 'edit_file', { path: 'src/new.ts', old_string: 'a', new_string: 'b' })).toMatchObject({ ok: false, error: expect.stringMatching(/^not-found/) });
    expect(await planWorkspaceEdit(scope, 'write_file', { path: 'src/new.ts', content: 'hello\n' })).toMatchObject({ ok: true, beforeVersion: ABSENT_FILE_VERSION,
      preview: expect.stringContaining('--- /dev/null') });
  });

  it('never resolves a write outside the workspace, onto a denied path or through a symlinked directory', async () => {
    const { root, scope } = await workspace();
    await mkdir(join(root, '..', `${root.split('/').at(-1)}-outside`)); roots.push(join(root, '..', `${root.split('/').at(-1)}-outside`));
    await symlink(join(root, '..', `${root.split('/').at(-1)}-outside`), join(root, 'linked'));
    await symlink(join(root, 'src'), join(root, 'inner'));
    for (const [path, error] of [['../escape.ts', 'invalid-path'], ['/etc/passwd', 'outside-workspace'], ['.env', 'denied'], ['.git/hooks/pre-commit', 'denied'],
      ['linked/x.ts', 'parent-path-outside-workspace'], ['inner/x.ts', 'parent-is-link'], ['src/', 'invalid-path']] as const) {
      expect(await resolveWritable(scope, path)).toMatchObject({ ok: false, error });
    }
    expect(await resolveWritable(scope, `${root}/src/a.ts`)).toEqual({ ok: true, rel: 'src/a.ts', parentRel: 'src', name: 'a.ts' });
    await writeFile(join(root, 'src', 'bin.dat'), Buffer.from([0xff, 0xfe, 0x00]));
    expect(await planWorkspaceEdit(scope, 'edit_file', { path: 'src/bin.dat', old_string: 'x', new_string: 'y' })).toMatchObject({ ok: false, error: 'not-utf8-text' });
  });

  it('writes conditionally and atomically as an effect target, keeping the mode, and reads crash evidence from the file itself', async () => {
    const { root, scope, journal } = await workspace(); roots.push(journal);
    await chmod(join(root, 'src', 'a.ts'), 0o640);
    const target = new WorkspaceFileTarget(scope, journal), key = 'a'.repeat(64);
    const before = (await target.observe(ref('src/a.ts'))).version;
    const applied = await target.apply({ target: ref('src/a.ts'), operation: { id: 'workspace.file.write', version: 1 }, idempotencyKey: key, expectedVersion: before,
      input: { content: 'new\n' } });
    expect(applied).toEqual({ version: fileContentVersion(Buffer.from('new\n')) });
    expect(await readFile(join(root, 'src', 'a.ts'), 'utf8')).toBe('new\n');
    expect((await stat(join(root, 'src', 'a.ts'))).mode & 0o777).toBe(0o640);
    expect((await readdir(join(root, 'src'))).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(await target.lookup(ref('src/a.ts'), key)).toEqual({ status: 'applied', version: applied.version });
    // A stale precondition is refused before any change.
    await expect(target.apply({ target: ref('src/a.ts'), operation: { id: 'workspace.file.write', version: 1 }, idempotencyKey: 'b'.repeat(64),
      expectedVersion: before, input: { content: 'other\n' } })).rejects.toMatchObject({ code: 'EFFECT_TARGET_PRECONDITION' });
    expect(await readFile(join(root, 'src', 'a.ts'), 'utf8')).toBe('new\n');
    // A refused write left no journal; a journaled write whose file is still at `expected` is absent; changed by someone else → unknown.
    expect(await target.lookup(ref('src/a.ts'), 'b'.repeat(64))).toEqual({ status: 'absent' });
    // A crash after journaling but before the rename: the file is still at `expected`, so the idempotent write may be sent again.
    await writeFile(join(journal, `${'f'.repeat(64)}.json`), JSON.stringify({ schemaVersion: 1, rel: 'src/a.ts', expected: applied.version,
      next: fileContentVersion(Buffer.from('never written\n')) }));
    expect(await target.lookup(ref('src/a.ts'), 'f'.repeat(64))).toEqual({ status: 'absent' });
    await writeFile(join(root, 'src', 'a.ts'), 'someone else\n');
    expect(await target.lookup(ref('src/a.ts'), key)).toBeNull();
    expect(await target.lookup(ref('src/a.ts'), 'c'.repeat(64))).toEqual({ status: 'absent' });
    // A new file: expected `absent`.
    await target.apply({ target: ref('src/created.ts'), operation: { id: 'workspace.file.write', version: 1 }, idempotencyKey: 'd'.repeat(64),
      expectedVersion: ABSENT_FILE_VERSION, input: { content: 'created\n' } });
    expect((await readWritableFile(scope, { ok: true, rel: 'src/created.ts', parentRel: 'src', name: 'created.ts' }))).toMatchObject({ ok: true, version: fileContentVersion(Buffer.from('created\n')) });
    await expect(target.apply({ target: ref('.env'), operation: { id: 'workspace.file.write', version: 1 }, idempotencyKey: 'e'.repeat(64),
      expectedVersion: ABSENT_FILE_VERSION, input: { content: 'x' } })).rejects.toMatchObject({ code: 'EFFECT_TARGET_REJECTED' });
  });
});
