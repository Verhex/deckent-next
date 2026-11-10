import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { createBackupSet, verifyBackupSet, createBackupCoverage, verifyBackupCoverage } from '#adapters/core/backup-store/index.js';
import { type BackupCoverageManifest, type BackupContributionOwner } from '#engine/core/backup/index.js';
import { resolveProductLayout, productResourcePath } from '#platform/index.js';

it.skipIf(process.platform === 'win32')('round trips exact encrypted owner coverage alongside the existing backup, refusing missing/protected session coverage and unsafe destinations before export or restore [verify-not-run: platform custody unavailable]', async () => {
  const base = await mkdtemp(join(tmpdir(), 'deckent-backup-coverage-'));
  try {
    const project = join(base, 'project'), dataRoot = join(base, 'data'), layout = resolveProductLayout({ projectRoot: project, root: dataRoot });
    await mkdir(project, { mode: 0o700 }); await mkdir(dataRoot, { mode: 0o700 });
    const file = async (path: string, bytes: string | Uint8Array) => { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, bytes, { mode: 0o600 }); };
    await file(productResourcePath(layout, 'config'), '{}'); await file(productResourcePath(layout, 'policy'), '{}'); await file(productResourcePath(layout, 'bindings'), '{}');
    await file(join(productResourcePath(layout, 'installationIdentity'), 'identity.json'), '{"installationId":"temporary"}');
    await file(join(productResourcePath(layout, 'audit'), 'event'), 'sealed-audit-fixture');
    await file(join(productResourcePath(layout, 'approvals'), 'authority.key'), Buffer.alloc(32, 9));
    const ledger = productResourcePath(layout, 'ledger'); await mkdir(dirname(ledger), { mode: 0o700 });
    const db = new DatabaseSync(ledger); db.exec('CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES(\'retained\');'); db.close();
    const { chmod } = await import('node:fs/promises'); await chmod(ledger, 0o600);
    const limits = { maxFiles: 100, maxDepth: 10, maxFileBytes: 1 << 20, maxTotalBytes: 1 << 22 }, phrase = 'fixture-private-backup-passphrase';
    const set = join(base, 'set'); await createBackupSet(layout, project, 'temporary', 'authority.key', set, phrase, limits);
    const recovery = join(base, 'recovery'); await mkdir(recovery, { mode: 0o700 });
    const values = { ledger: await readFile(ledger), audit: Buffer.from('sealed-audit-fixture'), key: Buffer.alloc(32, 9),
      signer: Buffer.from('fixture-signer-material'), secret: Buffer.from('fixture-synthetic-credential') };
    const manifest: BackupCoverageManifest = { schemaVersion: 1, installationId: 'temporary', generation: 'g1', planDigest: 'a'.repeat(64),
      resources: Object.keys(values).map(resourceId => ({ resourceId, owner: 'fixture-owner', version: 'v1', transfer: 'portable' as const })) };
    let exports = 0; const restored = new Map<string, Buffer>();
    const owner: BackupContributionOwner = { id: 'fixture-owner', transfer: id => id === 'session' ? 'protected-renewable-session' : 'portable',
      async export(resource) { exports++; return values[resource.resourceId as keyof typeof values]; },
      async validateRestore(resource, bytes) { expect(Buffer.from(bytes)).toEqual(values[resource.resourceId as keyof typeof values]); },
      async restore(resource, bytes) { restored.set(resource.resourceId, Buffer.from(bytes)); } };
    const input = { companion: join(recovery, 'coverage.enc'), manifest, deletionRoots: [project, dataRoot] }, verifiedSet = await verifyBackupSet(set, phrase, limits);
    await expect(createBackupCoverage(verifiedSet, input, phrase, limits, [], async work => work())).rejects.toMatchObject({ code: 'BACKUP_COVERAGE_INCOMPLETE' });
    await expect(createBackupCoverage(verifiedSet, { ...input, manifest: { ...manifest, resources: [{ resourceId: 'session', owner: owner.id, version: 'v1', transfer: 'portable' }] } }, phrase, limits, [owner], async work => work())).rejects.toMatchObject({ code: 'BACKUP_COVERAGE_INCOMPLETE' });
    await expect(createBackupCoverage(verifiedSet, { ...input, companion: join(dataRoot, 'unsafe.enc') }, phrase, limits, [owner], async work => work())).rejects.toMatchObject({ code: 'BACKUP_PATH_UNSAFE' });
    expect(exports).toBe(0);
    await createBackupCoverage(verifiedSet, input, phrase, limits, [owner], async work => work());
    const ciphertext = await readFile(input.companion, 'utf8');
    expect(ciphertext).not.toContain('fixture-synthetic-credential'); expect(ciphertext).not.toContain(values.secret.toString('base64'));
    const verified = await verifyBackupCoverage(verifiedSet, input, phrase, limits, [owner]); await verified.restore(); verified.close();
    expect(Object.fromEntries(restored)).toEqual(values);
    const oldBackup = await verifyBackupSet(set, phrase, limits); expect(oldBackup.state.schemaVersion).toBe(2); oldBackup.close();
    await expect(verifyBackupCoverage(verifiedSet, { ...input, manifest: { ...manifest, planDigest: 'b'.repeat(64) } }, phrase, limits, [owner])).rejects.toMatchObject({ code: 'BACKUP_PASSPHRASE_INVALID' });
    // Same ledger bytes do not make a different snapshot interchangeable with this recovery companion.
    await file(join(productResourcePath(layout, 'audit'), 'event'), 'new-audit-snapshot');
    const secondSet = join(base, 'second-set'); await createBackupSet(layout, project, 'temporary', 'authority.key', secondSet, phrase, limits);
    const second = await verifyBackupSet(secondSet, phrase, limits);
    await expect(verifyBackupCoverage(second, input, phrase, limits, [owner])).rejects.toMatchObject({ code: 'BACKUP_PASSPHRASE_INVALID' }); second.close(); verifiedSet.close();
    expect(exports).toBe(5);
  } finally { await rm(base, { recursive: true, force: true }); }
});

it('refuses backup coverage without POSIX owner custody before opening a path', async () => {
  const uid = Object.getOwnPropertyDescriptor(process, 'getuid');
  Object.defineProperty(process, 'getuid', { configurable: true, value: undefined });
  try {
    await expect(createBackupCoverage({ set: 'not-opened' } as never, { companion: 'not-opened', manifest: { schemaVersion: 1, installationId: 'fixture', generation: 'g1', planDigest: 'a'.repeat(64), resources: [] }, deletionRoots: ['not-opened'] }, 'fixture', { maxFiles: 10, maxDepth: 3, maxFileBytes: 100, maxTotalBytes: 1000 }, [], async work => work())).rejects.toMatchObject({ code: 'BACKUP_PATH_UNSAFE' });
  } finally {
    if (uid) Object.defineProperty(process, 'getuid', uid); else Reflect.deleteProperty(process, 'getuid');
  }
});
