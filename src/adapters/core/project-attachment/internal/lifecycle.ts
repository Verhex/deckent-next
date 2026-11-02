import { resolve } from 'node:path';
import type { BackupStoragePort } from '#engine/index.js';
import { attachmentFailure } from '#engine/index.js';
import type { ConfigLoadOptions, ResolvedConfig } from '#platform/index.js';
import { FileProjectAttachmentStore } from './store.js';
export function attachmentLifecycle(config: ResolvedConfig, options: ConfigLoadOptions) {
  const store = new FileProjectAttachmentStore(config.productLayout, options, config.installation.profileMaxBytes, config.installation.writeLockTimeoutMs);
  const assert = async (extra: readonly string[] = []) => {
    const registration = await store.registration(), roots = [config.projectRoot, ...extra].map(root => resolve(root));
    if (config.installation.sharedRegistrationId || await store.attachment() || registration && (roots.includes(registration.source.projectRoot)
      || registration.entries.some(entry => roots.includes(entry.attachment.location.canonicalRoot)))) return attachmentFailure('PROJECT_ATTACHMENT_LIFECYCLE_BLOCKED');
  };
  return { assert, hold: <T>(work: () => Promise<T>, roots: readonly string[] = []) => store.hold(async () => { await assert(roots); return work(); }) };
}
/** Backup policy authorization happens in BackupApplication before this storage effect port. */
type LocatedBackupStorage = BackupStoragePort & Required<Pick<BackupStoragePort, 'locate'>>;
export function attachmentGuardedBackupStorage(storage: LocatedBackupStorage, config: ResolvedConfig, options: ConfigLoadOptions): LocatedBackupStorage {
  const guard = attachmentLifecycle(config, options);
  return { locate: (set: string) => storage.locate(set),
    execute: (command, passphrase) => guard.hold(() => storage.execute(command, passphrase), command.action === 'restore' ? [command.target] : []) };
}
