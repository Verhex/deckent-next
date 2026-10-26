import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { openOnboardingDeferrals } from '#adapters/index.js';
it('U4-1: deferrals preserve principal/folder isolation, legacy root-only reads and no-follow bounded custody', async () => {
  if (process.platform === 'win32') { expect(() => openOnboardingDeferrals('unused')).toThrow('MANAGED_FILE_UNSUPPORTED'); return; }
  const root = await mkdtemp(join(tmpdir(), 'onboarding-')), path = join(root, 'state.json'), store = openOnboardingDeferrals(path);
  const entry = { principal: 'alice', folder: '', stageId: 'core:model', planDigest: 'a'.repeat(64), deferredAt: 100 };
  try {
    await store.defer(entry); await store.defer({ ...entry, folder: 'orders', stageId: 'onboarding:first-task' });
    expect((await store.list('alice', '')).map(row => row.stageId)).toEqual(['core:model']); expect(await store.list('bob', '')).toEqual([]);
    expect((await store.list('alice', 'orders')).map(row => row.stageId)).toEqual(['onboarding:first-task']);
    // R18: settling forgets only this principal's named steps in this folder.
    await store.defer({ ...entry, principal: 'bob' }); await store.settle('alice', '', ['core:model']);
    expect(await store.list('alice', '')).toEqual([]); expect((await store.list('bob', '')).length).toBe(1); expect((await store.list('alice', 'orders')).length).toBe(1);
    const legacy = { ...entry } as Partial<typeof entry>; delete legacy.folder;
    await writeFile(path, JSON.stringify({ schemaVersion: 1, entries: [legacy] }), { mode: 0o600 });
    expect((await store.list('alice', '')).length).toBe(1); expect(await store.list('alice', 'orders')).toEqual([]);
    const target = join(root, 'target'); await writeFile(target, 'unchanged'); await rm(path); await symlink(target, path);
    await expect(store.defer(entry)).rejects.toBeDefined(); expect(await readFile(target, 'utf8')).toBe('unchanged');
  } finally { await rm(root, { recursive: true, force: true }); }
});
