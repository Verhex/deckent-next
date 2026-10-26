import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { createBackupSet, verifyBackupSet, createBackupCoverage, verifyBackupCoverage } from '#adapters/core/backup-store/index.js';
import { type BackupCoverageManifest, type BackupContributionOwner } from '#engine/core/backup/index.js';
import { resolveProductLayout, productResourcePath } from '#platform/index.js';

it('round trips exact encrypted owner coverage alongside the existing backup, refusing missing/protected session coverage and unsafe destinations before export or restore', async () => {
  if (process.platform === 'win32') {
    await expect(createBackupCoverage({ set: 'not-opened', companion: 'not-opened', manifest: { schemaVersion: 1, installationId: 'fixture', generation: 'g1', planDigest: 'a'.repeat(64), resources: [] }, deletionRoots: ['not-opened'] }, 'fixture', { maxFiles: 10, maxDepth: 3, maxFileBytes: 100, maxTotalBytes: 1000 }, [], async work => work())).rejects.toMatchObject({ code: 'BACKUP_PATH_UNSAFE' });
    console.info('verify-not-run: backup coverage POSIX file custody unavailable'); return;
  }
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
    const input = { set, companion: join(recovery, 'coverage.enc'), manifest, deletionRoots: [project, dataRoot] };
    await expect(createBackupCoverage(input, phrase, limits, [], async work => work())).rejects.toMatchObject({ code: 'BACKUP_COVERAGE_INCOMPLETE' });
    await expect(createBackupCoverage({ ...input, manifest: { ...manifest, resources: [{ resourceId: 'session', owner: owner.id, version: 'v1', transfer: 'portable' }] } }, phrase, limits, [owner], async work => work())).rejects.toMatchObject({ code: 'BACKUP_COVERAGE_INCOMPLETE' });
    await expect(createBackupCoverage({ ...input, companion: join(dataRoot, 'unsafe.enc') }, phrase, limits, [owner], async work => work())).rejects.toMatchObject({ code: 'BACKUP_PATH_UNSAFE' });
    expect(exports).toBe(0);
    await createBackupCoverage(input, phrase, limits, [owner], async work => work());
    const ciphertext = await readFile(input.companion, 'utf8');
    expect(ciphertext).not.toContain('fixture-synthetic-credential'); expect(ciphertext).not.toContain(values.secret.toString('base64'));
    const verified = await verifyBackupCoverage(input, phrase, limits, [owner]); await verified.restore(); verified.close();
    expect(Object.fromEntries(restored)).toEqual(values);
    const oldBackup = await verifyBackupSet(set, phrase, limits); expect(oldBackup.state.schemaVersion).toBe(2); oldBackup.close();
    await expect(verifyBackupCoverage({ ...input, manifest: { ...manifest, planDigest: 'b'.repeat(64) } }, phrase, limits, [owner])).rejects.toMatchObject({ code: 'BACKUP_PASSPHRASE_INVALID' });
    // Same ledger bytes do not make a different snapshot interchangeable with this recovery companion.
    await file(join(productResourcePath(layout, 'audit'), 'event'), 'new-audit-snapshot');
    const secondSet = join(base, 'second-set'); await createBackupSet(layout, project, 'temporary', 'authority.key', secondSet, phrase, limits);
    await expect(verifyBackupCoverage({ ...input, set: secondSet }, phrase, limits, [owner])).rejects.toMatchObject({ code: 'BACKUP_PASSPHRASE_INVALID' });
    expect(exports).toBe(5);
  } finally { await rm(base, { recursive: true, force: true }); }
});

it('exports only registered private file trees and restores verified contributions without overwriting existing files or following a link', async () => {
  if (process.platform === 'win32') { console.info('verify-not-run: private POSIX coverage owner'); return; }
  const { FileTreeBackupOwner } = await import('#adapters/core/backup-store/index.js');
  const { symlink } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'deckent-backup-tree-'));
  try {
    const source = join(root, 'signers'), target = join(root, 'restored'); await mkdir(source, { mode: 0o700 });
    await writeFile(join(source, 'fixture.key'), 'SYNTHETIC PRIVATE KEY', { mode: 0o600 });
    const limits = { maxFiles: 10, maxDepth: 3, maxFileBytes: 65536, maxTotalBytes: 262144 };
    const owner = new FileTreeBackupOwner([{ resourceId: 'signers', path: source }], limits), resource = { resourceId: 'signers', owner: owner.id, version: 'snapshot', transfer: 'portable' as const };
    const bytes = await owner.export(resource), restore = new FileTreeBackupOwner([{ resourceId: 'signers', path: target }], limits);
    await restore.validateRestore(resource, bytes); await restore.restore(resource, bytes);
    expect(await readFile(join(target, 'fixture.key'), 'utf8')).toBe('SYNTHETIC PRIVATE KEY');
    await expect(restore.restore(resource, bytes)).rejects.toMatchObject({ code: 'BACKUP_TARGET_NOT_EMPTY' });
    await symlink(target, join(source, 'foreign-link'));
    await expect(owner.export(resource)).rejects.toMatchObject({ code: 'BACKUP_PATH_UNSAFE' });
    await expect(restore.validateRestore(resource, Buffer.from('{"schemaVersion":1,"entries":[{"path":"../escape","directory":false,"content":"YQ=="}]}'))).rejects.toMatchObject({ code: 'BACKUP_SET_INVALID' });
    bytes.fill(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
