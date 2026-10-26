import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { BackupApplication, EffectTargetError, policyBackupAuthorization, type UninstallPlan } from '#engine/index.js';
import type { VerifiedPrincipal } from '#domain/index.js';
import { FileBackupStorage, recordBackupAudit, readBackupConfig, verifyBackupSet, ledgerFingerprint, type VerifiedBackup } from '#adapters/core/backup-store/index.js';
import { resolveGlobalConfigReadPath, sha256, type ResolvedConfig, type ConfigLoadOptions, type IntegrityAuthority } from '#platform/index.js';
import { fileDigest, memberStat, type DataRemovalMember, type DataRemovalSnapshot } from './data.js';
import { writeUninstallIntent } from './tombstone.js';
import paths from './paths.json' with { type: 'json' };
const unbound = (): never => { throw new EffectTargetError('EFFECT_TARGET_PRECONDITION'); };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Binds one member's current bytes to the verified set: the exact archived content, the ledger's table fingerprint or the sealed key. */
async function bindMember(verified: VerifiedBackup, member: DataRemovalMember, busyTimeoutMs: number): Promise<DataRemovalSnapshot['members'][number] | null> {
  if (!await memberStat(member.path)) return null;
  if (member.resourceId === 'ledger') {
    // Read-only readers leave empty SQLite sidecars; a checkpoint by the last connection removes them. Any left means another reader: keep.
    const db = new DatabaseSync(member.path, { timeout: busyTimeoutMs }); try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
    for (const suffix of ['-wal', '-shm', '-journal']) if (await lstat(member.path + suffix).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) unbound();
  }
  const before = await memberStat(member.path);
  if (!before) return unbound();
  const current = await fileDigest(member.path), state = verified.state;
  const backed = member.resourceId === 'ledger' ? ledgerFingerprint(member.path) === await readFile(join(verified.set, 'ledger.fingerprint.json'), 'utf8')
    : member.resourceId === 'approvals' ? sha256((await readFile(member.path)).toString('hex')) === verified.integrity().keyId
      : state.entries.some(entry => entry.resource === member.resourceId && entry.path === member.archivePath && digest(Buffer.from(entry.content, 'base64')) === current);
  const after = await memberStat(member.path);
  if (!backed || !after || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return unbound();
  return { path: member.path, digest: current, dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs, directory: member.directory };
}
/** The existing backup application owns create/verify/audit of the standard set that `deckent backup restore` restores. The final set is
 * re-verified, every member is bound to its exact verified content and a durable final-tail intent is written before any deletion. */
export async function prepareUninstallBackup(config: ResolvedConfig, plan: UninstallPlan, scopeId: string, principal: VerifiedPrincipal,
  policy: unknown, integrity: IntegrityAuthority, members: readonly DataRemovalMember[], passphrase: string, final: boolean, options: ConfigLoadOptions) {
  if (!plan.backup.destination) throw new Error('UNINSTALL_BACKUP_COVERAGE');
  const limits = config.installation.packageMeasurement, layout = config.productLayout;
  const set = join(plan.backup.destination, `${final ? paths.finalBackupPrefix : paths.initialBackupPrefix}${randomUUID()}`), globalPath = await resolveGlobalConfigReadPath(options.env, options.platform);
  const storage = new FileBackupStorage({ layout, projectRoot: config.projectRoot, installationId: plan.installation.id, keyFile: config.approvals.keyFile,
    configDocument: () => readBackupConfig(layout.bootstrapConfigPath, globalPath, limits) }, limits);
  const audit = join(set, '..', 'backup-audit');
  const app = new BackupApplication(storage, policyBackupAuthorization(policy), (event, authority) => recordBackupAudit(audit, event, authority),
    { principal, installationId: plan.installation.id, integrity });
  await app.execute({ schemaVersion: 1, action: 'create', scopeId, set }, passphrase);
  await app.execute({ schemaVersion: 1, action: 'verify', scopeId, set }, passphrase);
  if (!final) return { set, snapshot: null };
  const verified = await verifyBackupSet(set, passphrase, limits);
  try {
    if (verified.state.installationId !== plan.installation.id) unbound();
    const bound = [];
    for (const member of members) { const value = await bindMember(verified, member, config.storage.sqlite.busyTimeoutMs); if (value) bound.push(value); }
    const snapshot: DataRemovalSnapshot = { set: verified.set, manifestDigest: digest(await readFile(join(verified.set, 'MANIFEST.sha256'))), members: bound };
    await writeUninstallIntent(layout.root, principal, plan, snapshot);
    return { set, snapshot };
  } finally { verified.close(); }
}
