import { delegationOwner, installationSourceSchema } from '#domain/index.js';
import { attachmentFailure, type InstallationContextPorts, type InstallationIdentityRead, type RegisteredInstallationBinding } from '#engine/index.js';
import { FileInstallationIdentityStore, FileProjectIdentityStore } from '#adapters/core/installation-files/index.js';
import { FileProjectAttachmentStore, captureAttachmentLocation, observeAttachmentFilesystemIdentity } from './store.js';
import { repairAttachedProject, repairRegisteredInstallationSource, type AttachmentContextWrite } from './relocation.js';
import type { ResolvedConfig, ConfigLoadOptions } from '#platform/index.js';
/** Reconstruct the selected source from its current configuration and policy, never from a caller-supplied layout alone. */
export async function inspectInstallationSourceFiles(config: ResolvedConfig, scopeId: string, actor: { readonly issuer: string; readonly subject: string },
  authorize: () => Promise<void>, locked?: RegisteredInstallationBinding) {
  if (config.installation.sharedRegistrationId) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
  const layout = config.productLayout, observedLocation = await captureAttachmentLocation(layout.root);
  const location = locked ? { canonicalRoot: locked.capture.canonicalRoot, device: locked.capture.device, inode: locked.capture.inode } : observedLocation;
  if (JSON.stringify(location) !== JSON.stringify(observedLocation)) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
  await captureAttachmentLocation(config.projectRoot);
  await authorize();
  const identity: InstallationIdentityRead = locked ? { status: 'available', value: locked.identity, bindingCapability: 'supported' }
    : await new FileInstallationIdentityStore(layout, config.configFile.writeLockTimeoutMs, undefined, config.installation).read();
  const project = await new FileProjectIdentityStore(config.projectRoot, config.configFile.writeLockTimeoutMs).read();
  if (identity.status !== 'available' || identity.pendingWrite || identity.value.realmSeal || project.status !== 'available') return attachmentFailure('PROJECT_ATTACHMENT_UNAVAILABLE');
  const source = installationSourceSchema.parse({ projectRoot: config.projectRoot, layoutRoot: layout.root, bootstrapConfigPath: layout.bootstrapConfigPath,
    layoutRevision: layout.revision, installationId: identity.value.installationId, projectId: project.value.projectId,
    companyId: config.company.id, scopeId, owner: delegationOwner(actor), location }); // a workload reads the source as the person it acts for
  return { source, identity, config };
}
export function localInstallationProjectContextPorts(config: ResolvedConfig, options: ConfigLoadOptions, source: InstallationContextPorts['source'],
  write?: AttachmentContextWrite): InstallationContextPorts {
  const store = new FileProjectAttachmentStore(config.productLayout, options, config.installation.profileMaxBytes, config.installation.writeLockTimeoutMs);
  const ports: InstallationContextPorts = { registration: () => store.registration(), attachment: () => store.attachment(), source, observeFilesystemIdentity: observeAttachmentFilesystemIdentity,
    target: async () => { const project = await new FileProjectIdentityStore(config.projectRoot, config.configFile.writeLockTimeoutMs).read();
      return { ...await captureAttachmentLocation(config.projectRoot), projectId: project.status === 'available' ? project.value.projectId : null }; },
    legacy: async () => {
      const scope = write?.scopeId;
      if (write && scope) await repairRegisteredInstallationSource(config, options, write.actor, scope, write.inspectSource,
        () => write.admitSource(config, scope));
      return new FileInstallationIdentityStore(config.productLayout, config.configFile.writeLockTimeoutMs, undefined, config.installation).read();
    } };
  if (!write) return ports;
  return { ...ports, repairSource: async (selected, requireActiveTarget) => {
    const sourceConfig = await write.loadSource(selected.projectRoot);
    await repairRegisteredInstallationSource(sourceConfig, options, write.actor, selected.scopeId, write.inspectSource,
      () => write.admitSource(sourceConfig, selected.scopeId), requireActiveTarget);
  }, repairTarget: (reference, requireActiveTarget, refusal) =>
    repairAttachedProject(store, ports.target, reference, requireActiveTarget, refusal, write) };
}
