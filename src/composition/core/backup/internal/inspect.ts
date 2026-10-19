import { restoreLeftovers, listBackupSets, lastBackupVerifications, openLocalIntegrityAuthority, type BackupSetEntry } from '#adapters/index.js';
import { listConfiguredSecretNames } from '#composition/core/secrets/index.js';
import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { productResourcePath, restoreHoldPath, type ConfigLoadOptions } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { BACKUP_SCHEDULE_SECRET } from './schedule.js';

/** Doctor's recovery-file view: files an interrupted restore left behind (S1 D4: stage, pending hold, decrypted key not yet in place) and
 * the project's installation directory mode (S1 D2: a mode open to group/other is shown, never changed). */
export interface RecoveryFilesView { readonly leftovers: readonly string[]; readonly installationDirectory: { readonly path: string; readonly mode: string } | null }
/** Read-only; the configuration is read without resolving any secret reference. */
export async function inspectConfiguredRecoveryFiles(projectRoot: string, options: ConfigLoadOptions = {}): Promise<RecoveryFilesView> {
  const config = await loadComposedConfig(projectRoot, { ...options, heal: false, secretResolver: async () => undefined, onWarning() {} });
  const path = dirname(restoreHoldPath(config.projectRoot)), info = await lstat(path).catch(() => null);
  return { leftovers: await restoreLeftovers(config.projectRoot, productResourcePath(config.productLayout, 'approvals'), config.approvals.keyFile),
    installationDirectory: info?.isDirectory() ? { path, mode: (info.mode & 0o777).toString(8).padStart(4, '0') } : null };
}
/** C-ADMIN `deckent backup`: the default recovery folder's sets (no passphrase, nothing decrypted), the schedule, and whether the scheduled
 * backup passphrase is kept in this installation's own store (lost with the machine; read through the assurance-gated name reader, unknown when refused). Last verification comes only from sealed records. */
export async function inspectConfiguredBackupSets(projectRoot: string, options: ConfigLoadOptions = {}) {
  const config = await loadComposedConfig(projectRoot, { ...options, heal: false, secretResolver: async () => undefined, onWarning() {} });
  const layout = config.productLayout, limits = config.installation.packageMeasurement, directory = join(productResourcePath(layout, 'ledgerBackups'), 'recovery');
  const authority = await openLocalIntegrityAuthority(layout, config.approvals.keyFile).catch(() => null);
  const verified = authority ? await lastBackupVerifications(join(productResourcePath(layout, 'audit'), 'backup-operations'), limits, authority) : new Map<string, number>();
  const names = await listConfiguredSecretNames(projectRoot, options).then(view => view.names, () => null); // assurance-gated; refused or failed: unknown
  return { schemaVersion: 1 as const, directory, schedule: config.backup.schedule, retention: config.backup.retention,
    passphraseStored: names ? names.includes(BACKUP_SCHEDULE_SECRET) : null, sets: await listBackupSets(directory, limits, verified) as readonly BackupSetEntry[] };
}
