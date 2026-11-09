import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { EffectTargetError, type UninstallPlan } from '#engine/index.js';
import type { VerifiedPrincipal } from '#domain/index.js';
import type { VerifiedBackup } from '#adapters/core/backup-store/index.js';
import { productResourcePath, readPinnedFile, fileDigest, DECKENT_DIR, ErrorRegistry, type BoundMember, type ResolvedConfig, type ProductResource, type ConfigLoadOptions } from '#platform/index.js';
import { memberStat, type DataRemovalMember, type DataRemovalSnapshot } from './data.js';
import { writeUninstallIntent } from './tombstone.js';
import { configuredTracking } from './vcs.js';
import { createUninstallArchive, uninstallArchiveRoots } from './archive.js';
import paths from './paths.json' with { type: 'json' };
const unbound = (): never => { throw new EffectTargetError('EFFECT_TARGET_PRECONDITION'); };
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
  if (!verified.holds(member, before.bytes) || (await readPinnedFile(member.path))?.identity.digest !== before.identity.digest) return unbound();
  return { path: member.path, ...before.identity, directory: member.directory };
}
/** Where an uninstall's standard restorable set goes: the initial set before any effect, the final set before deletion. */
export function uninstallBackupSet(plan: UninstallPlan, kind: 'initial' | 'final'): string {
  if (!plan.backup.destination) throw ErrorRegistry.createError('UNINSTALL_BACKUP_COVERAGE');
  return join(plan.backup.destination, `${paths[`${kind}BackupPrefix`]}${randomUUID()}`);
}
/** What an uninstall set must hold: the members of the data resources the approved plan removes. */
export interface UninstallSetMembers { readonly config: ResolvedConfig; readonly plan: UninstallPlan; readonly approved: string; readonly members: readonly DataRemovalMember[];
  readonly globalPath: string; readonly env: ConfigLoadOptions['env'] }
/** M5: the archived members go into a verified archive bound to the verified set, so a member that cannot be archived stops the plan before anything goes. */
export async function archiveUninstallMembers(verified: VerifiedBackup, input: UninstallSetMembers, passphrase: string) {
  const { config, plan } = input, layout = config.productLayout;
  // Only the members of the data resource this plan removes; archived files bind to the archive, the authority set to the semantic set.
  const removing = new Set(plan.items.filter(item => item.action === 'remove').map(item => item.resourceId)), own = input.members.filter(member => removing.has(member.target ?? 'global-data'));
  const tracked = await configuredTracking(config); // B2: a member the project's VCS tracks now (git add after the card) is never deleted
  if (own.some(member => tracked(member.path))) unbound();
  const archived = own.some(member => member.archived) ? await createUninstallArchive(verified, uninstallArchiveRoots(config.projectRoot, dirname(input.globalPath), input.env), own.filter(member => member.archived),
    { installationId: plan.installation.id, approved: input.approved, plan: plan.planDigest }, passphrase, config.installation.packageMeasurement,
    path => verified.state.entries.some(entry => join(productResourcePath(layout, entry.resource as ProductResource), entry.path) === path)) : null;
  return { own, archived };
}
/** The final set: archived as above, every other member bound to its exact verified content and a durable final-tail intent written before any deletion. */
export async function bindFinalSnapshot(verified: VerifiedBackup, input: UninstallSetMembers, passphrase: string, principal: VerifiedPrincipal): Promise<DataRemovalSnapshot> {
  const { config, plan } = input, layout = config.productLayout, { own, archived } = await archiveUninstallMembers(verified, input, passphrase), bound = [...archived?.members ?? []];
  for (const member of own.filter(member => !member.archived)) { const value = await bindMember(verified, member, config.storage.sqlite.busyTimeoutMs); if (value) bound.push(value); }
  const snapshot: DataRemovalSnapshot = { set: verified.set, manifestDigest: verified.manifestDigest, members: bound,
    root: layout.root === join(config.projectRoot, DECKENT_DIR) ? layout.root : undefined, archive: archived?.archive };
  const kept = async (resource: 'policy' | 'bindings') => { const path = productResourcePath(layout, resource);
    return own.some(member => member.path === path) || !await memberStat(path) ? null : fileDigest(path); };
  await writeUninstallIntent(dirname(plan.backup.destination!), layout.root, principal, plan, snapshot, { policy: await kept('policy'), bindings: await kept('bindings') });
  return snapshot;
}
