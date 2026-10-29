import { mkdtemp, mkdir, chmod, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { beuserPrivateRecord } from '#adapters/core/beuser-realm/index.js';

it.skipIf(process.platform === 'win32')('reopens bounded private records and refuses permissive or linked controller metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beuser-records-'));
  try {
    const directory = join(root, 'private'), file = beuserPrivateRecord(directory, 'record', 1024);
    expect(await file.read()).toEqual({ kind: 'absent' });
    await file.write({ attemptId: 'attempt', state: 'unknown' });
    expect(await beuserPrivateRecord(directory, 'record', 1024).read()).toMatchObject({ kind: 'ready', value: { attemptId: 'attempt', state: 'unknown' } });
    await expect(file.write({ bytes: 'x'.repeat(1024) })).rejects.toMatchObject({ code: 'BEUSER_LIMITS_UNAVAILABLE' });
    await chmod(join(directory, 'record.json'), 0o644);
    await expect(file.read()).rejects.toMatchObject({ code: 'BEUSER_TARGET_NOT_SANDBOX' });
    const elsewhere = join(root, 'elsewhere'); await mkdir(elsewhere, { mode: 0o700 });
    await symlink(elsewhere, join(root, 'linked'));
    await expect(beuserPrivateRecord(join(root, 'linked'), 'record', 1024).read()).rejects.toMatchObject({ code: 'BEUSER_TARGET_NOT_SANDBOX' });
    await expect(beuserPrivateRecord(join(root, 'linked'), 'record', 1024).write({ state: 'forged' })).rejects.toMatchObject({ code: 'BEUSER_TARGET_NOT_SANDBOX' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
