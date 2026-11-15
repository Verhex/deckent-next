import { isNewAttachmentRegistration, isNewAttachment } from '#domain/index.js';
import { resolve } from 'node:path';
import { attachmentFailure, attachmentLifecycleIdentity, type BackupStoragePort } from '#engine/index.js';
import { FileProjectIdentityStore, FileInstallationIdentityStore } from '#adapters/core/installation-files/index.js';
import { readLocalOsIdentity } from '#adapters/core/local-principal/index.js';
import type { ConfigLoadOptions, ResolvedConfig } from '#platform/index.js';
import { FileProjectAttachmentStore, captureAttachmentLocation, observeAttachmentFilesystemIdentity } from './store.js';
/** Lifecycle custody reads a retained project reference even after detach. It grants no session or model use. */
export function attachmentLifecycle(config: ResolvedConfig, options: ConfigLoadOptions) {
  const store = new FileProjectAttachmentStore(config.productLayout, options, config.installation.profileMaxBytes, config.installation.writeLockTimeoutMs);
  const identityId = async (): Promise<string> => {
    const attachment = await store.attachment();
    if (!config.installation.sharedRegistrationId) {
      if (attachment) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
      const identity = await new FileInstallationIdentityStore(config.productLayout, config.configFile.writeLockTimeoutMs, undefined, config.installation).read();
      if (identity.status !== 'available' || identity.value.realmSeal) return attachmentFailure('PROJECT_ATTACHMENT_UNAVAILABLE');
      return identity.value.installationId;
    }
    const registration = await store.registration(), project = await new FileProjectIdentityStore(config.projectRoot, config.configFile.writeLockTimeoutMs).read();
    await FileInstallationIdentityStore.assertTransferAllowed(config.productLayout);
    const location = await captureAttachmentLocation(config.projectRoot);
    const observed = attachment && 'filesystemIdentity' in attachment.location ? { ...location, filesystemIdentity: await observeAttachmentFilesystemIdentity(location) } : location;
    return attachmentLifecycleIdentity({ registrationId: config.installation.sharedRegistrationId, companyId: config.company.id,
      projectId: project.status === 'available' ? project.value.projectId : null, registration, attachment, actor: readLocalOsIdentity(), location: observed });
  };
  const assert = async (extra: readonly string[] = [], action: 'backup' | 'uninstall' = 'uninstall') => {
    const registration = await store.registration(), roots = [config.projectRoot, ...extra].map(root => resolve(root));
    if (config.installation.sharedRegistrationId || await store.attachment()) { await identityId(); return; }
    if (registration && roots.some(root => registration.entries.some(entry => root === entry.attachment.location.canonicalRoot))) return attachmentFailure('PROJECT_ATTACHMENT_SOURCE_REGISTERED');
    if (action === 'uninstall' && registration && roots.includes(registration.source.projectRoot) && !registration.unregistered)
      return attachmentFailure('PROJECT_ATTACHMENT_SOURCE_REGISTERED');
  };
  const assertWritable = () => store.hold(async () => {
    if (isNewAttachmentRegistration(await store.registration()) || isNewAttachment(await store.attachment())) return attachmentFailure('PROJECT_ATTACHMENT_NEWER_RECORD');
  });
  return { assert, identityId, assertWritable, hold: <T>(work: () => Promise<T>, roots: readonly string[] = [], action: 'backup' | 'uninstall' = 'uninstall') =>
    store.hold(async () => { await assert(roots, action); return work(); }) };
}
type LocatedBackupStorage = BackupStoragePort & Required<Pick<BackupStoragePort, 'locate'>>;
export function attachmentGuardedBackupStorage(storage: LocatedBackupStorage, config: ResolvedConfig, options: ConfigLoadOptions): LocatedBackupStorage {
  const guard = attachmentLifecycle(config, options);
  return { locate: (set: string) => storage.locate(set),
    execute: (command, passphrase) => guard.hold(() => storage.execute(command, passphrase), command.action === 'restore' ? [command.target] : [], 'backup') };
}
