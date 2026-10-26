import { randomUUID } from 'node:crypto';
import paths from './paths.json' with { type: 'json' };
import { join } from 'node:path';
import { BackupApplication, policyBackupAuthorization, type UninstallPlan, type BackupCoverageManifest } from '#engine/index.js';
import type { VerifiedPrincipal } from '#domain/index.js';
import { FileBackupStorage, FileTreeBackupOwner, createBackupCoverage, verifyBackupCoverage, recordBackupAudit, readBackupConfig } from '#adapters/core/backup-store/index.js';
import { productResourcePath, resolveGlobalConfigReadPath, type ResolvedConfig, type ConfigLoadOptions, type IntegrityAuthority } from '#platform/index.js';
import type { CacheRemovalResource } from './cache.js';
/** The existing backup application owns create/verify/audit; its encrypted coverage owner supplies every portable removal root. */
export async function prepareUninstallBackup(config: ResolvedConfig, plan: UninstallPlan, scopeId: string, principal: VerifiedPrincipal,
  policy: unknown, integrity: IntegrityAuthority, resources: readonly CacheRemovalResource[], passphrase: string, final: boolean, options: ConfigLoadOptions) {
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
  const owner = new FileTreeBackupOwner(resources, limits);
  const manifest: BackupCoverageManifest = { schemaVersion: 1, installationId: plan.installation.id, generation: plan.layoutRevision, planDigest: plan.planDigest,
    resources: await Promise.all(resources.map(async resource => ({ resourceId: resource.resourceId, owner: owner.id,
      version: await owner.version(resource.resourceId), transfer: 'portable' as const }))) };
  const input = { set, companion: `${set}.coverage.enc`, manifest, deletionRoots: [layout.root] };
  await createBackupCoverage(input, passphrase, limits, [owner], work => work());
  const verified = await verifyBackupCoverage(input, passphrase, limits, [owner]);
  verified.close();
  // The public, non-secret manifest is retained for the existing restore owner, outside all deletion roots.
  const { writeFile } = await import('node:fs/promises');
  await writeFile(`${set}${paths.coverageManifestSuffix}`, JSON.stringify(input), { mode: 0o600, flag: 'wx' });
  return { set, companion: input.companion, ledger: productResourcePath(layout, 'ledger') };
}
