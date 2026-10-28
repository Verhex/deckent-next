import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { BackupApplication, EffectTargetError, policyBackupAuthorization, type UninstallPlan } from '#engine/index.js';
import type { VerifiedPrincipal } from '#domain/index.js';
import { FileBackupStorage, recordBackupAudit, readBackupConfig, verifyBackupSet, ledgerFingerprint, type VerifiedBackup } from '#adapters/core/backup-store/index.js';
import { resolveGlobalConfigReadPath, productResourcePath, sha256, readPinnedFile, fileDigest, DECKENT_DIR, type BoundMember, type ResolvedConfig, type ProductResource, type ConfigLoadOptions, type IntegrityAuthority } from '#platform/index.js';
import { memberStat, type DataRemovalMember, type DataRemovalSnapshot } from './data.js';
import { writeUninstallIntent } from './tombstone.js';
import { configuredTracking } from './vcs.js';
import { createUninstallArchive, uninstallArchiveRoots } from './archive.js';
import paths from './paths.json' with { type: 'json' };
const unbound = (): never => { throw new EffectTargetError('EFFECT_TARGET_PRECONDITION'); };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Binds one member's current bytes to the verified set: the exact archived content, the ledger's table fingerprint or the sealed key. */
async function bindMember(verified: VerifiedBackup, member: DataRemovalMember, busyTimeoutMs: number): Promise<BoundMember | null> {
  if (!await memberStat(member.path)) return null;
  if (member.resourceId === 'ledger') {
    // Read-only readers leave empty SQLite sidecars; a checkpoint by the last connection removes them. Any left means another reader: keep.
    // node:sqlite loads only when a ledger is checkpointed, so importing the SDK never loads it (sqlite-ledger-lazy).
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(member.path, { timeout: busyTimeoutMs }); try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
    for (const suffix of ['-wal', '-shm', '-journal']) if (await lstat(member.path + suffix).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) unbound();
  }
  const before = await memberStat(member.path) && await readPinnedFile(member.path); if (!before) return unbound();
  const current = before.identity.digest, state = verified.state;
  const backed = member.resourceId === 'ledger' ? ledgerFingerprint(member.path) === await readFile(join(verified.set, 'ledger.fingerprint.json'), 'utf8')
    : member.resourceId === 'approvals' ? sha256(before.bytes.toString('hex')) === verified.integrity().keyId
      : state.entries.some(entry => entry.resource === member.resourceId && entry.path === member.archivePath && digest(Buffer.from(entry.content, 'base64')) === current);
  if (!backed || (await readPinnedFile(member.path))?.identity.digest !== current) return unbound();
  return { path: member.path, ...before.identity, directory: member.directory };
}
/** The existing backup application owns create/verify/audit of the standard set that `deckent backup restore` restores. The final set is
 * re-verified, every member is bound to its exact verified content and a durable final-tail intent is written before any deletion. The initial
 * set (before any effect) is archived and verified the same way, so a member that cannot be archived stops the plan before anything goes. */
export async function prepareUninstallBackup(config: ResolvedConfig, plan: UninstallPlan, scopeId: string, principal: VerifiedPrincipal,
  policy: unknown, integrity: IntegrityAuthority, members: readonly DataRemovalMember[], passphrase: string, final: boolean, options: ConfigLoadOptions, approved = plan.planDigest) {
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
  const verified = await verifyBackupSet(set, passphrase, limits);
  try {
    if (verified.state.installationId !== plan.installation.id) unbound();
    // Only the members of the data resource this plan removes; archived files bind to the archive, the authority set to the semantic set.
    const removing = new Set(plan.items.filter(item => item.action === 'remove').map(item => item.resourceId)), own = members.filter(member => removing.has(member.target ?? 'global-data'));
    const tracked = await configuredTracking(config); // B2: a member the project's VCS tracks now (git add after the card) is never deleted
    if (own.some(member => tracked(member.path))) unbound();
    const archived = own.some(member => member.archived) ? await createUninstallArchive(set, uninstallArchiveRoots(config.projectRoot, dirname(globalPath), options.env), own.filter(member => member.archived),
      { installationId: plan.installation.id, approved, plan: plan.planDigest }, passphrase, limits,
      path => verified.state.entries.some(entry => join(productResourcePath(layout, entry.resource as ProductResource), entry.path) === path)) : null, bound = [...archived?.members ?? []];
    // M5: the initial set already carries a verified archive of every member (limits, paths, coverage, passphrase) before the first removal.
    if (!final) return { set, snapshot: null };
    for (const member of own.filter(member => !member.archived)) { const value = await bindMember(verified, member, config.storage.sqlite.busyTimeoutMs); if (value) bound.push(value); }
    const snapshot: DataRemovalSnapshot = { set: verified.set, manifestDigest: digest(await readFile(join(verified.set, 'MANIFEST.sha256'))), members: bound,
      root: layout.root === join(config.projectRoot, DECKENT_DIR) ? layout.root : undefined, archive: archived?.archive };
    const kept = async (resource: 'policy' | 'bindings') => { const path = productResourcePath(layout, resource);
      return own.some(member => member.path === path) || !await memberStat(path) ? null : fileDigest(path); };
    await writeUninstallIntent(dirname(plan.backup.destination), layout.root, principal, plan, snapshot, { policy: await kept('policy'), bindings: await kept('bindings') });
    return { set, snapshot };
  } finally { verified.close(); }
}
