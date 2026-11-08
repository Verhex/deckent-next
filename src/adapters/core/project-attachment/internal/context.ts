import { delegationOwner, installationSourceSchema } from '#domain/index.js';
import { attachmentFailure, type InstallationContextPorts } from '#engine/index.js';
import { FileInstallationIdentityStore, FileProjectIdentityStore } from '#adapters/core/installation-files/index.js';
import { FileProjectAttachmentStore, captureAttachmentLocation } from './store.js';
import type { ResolvedConfig, ConfigLoadOptions } from '#platform/index.js';
/** Reconstruct the selected source from its current configuration and policy, never from a caller-supplied layout alone. */
export async function inspectInstallationSourceFiles(config: ResolvedConfig, scopeId: string, actor: { readonly issuer: string; readonly subject: string }, authorize: () => Promise<void>) {
  if (config.installation.sharedRegistrationId) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
  const layout = config.productLayout, location = await captureAttachmentLocation(layout.root);
  await captureAttachmentLocation(config.projectRoot);
  await authorize();
  const identity = await new FileInstallationIdentityStore(layout, config.configFile.writeLockTimeoutMs, undefined, config.installation).read();
  const project = await new FileProjectIdentityStore(config.projectRoot, config.configFile.writeLockTimeoutMs).read();
  if (identity.status !== 'available' || identity.pendingWrite || identity.value.realmSeal || project.status !== 'available') return attachmentFailure('PROJECT_ATTACHMENT_UNAVAILABLE');
  const source = installationSourceSchema.parse({ projectRoot: config.projectRoot, layoutRoot: layout.root, bootstrapConfigPath: layout.bootstrapConfigPath,
    layoutRevision: layout.revision, installationId: identity.value.installationId, projectId: project.value.projectId,
    companyId: config.company.id, scopeId, owner: delegationOwner(actor), location }); // a workload reads the source as the person it acts for
  return { source, identity, config };
}
export function localInstallationProjectContextPorts(config: ResolvedConfig, options: ConfigLoadOptions, source: InstallationContextPorts['source']): InstallationContextPorts {
  const store = new FileProjectAttachmentStore(config.productLayout, options, config.installation.profileMaxBytes, config.installation.writeLockTimeoutMs);
  return { registration: () => store.registration(), attachment: () => store.attachment(), source,
    target: async () => { const project = await new FileProjectIdentityStore(config.projectRoot, config.configFile.writeLockTimeoutMs).read();
      return { ...await captureAttachmentLocation(config.projectRoot), projectId: project.status === 'available' ? project.value.projectId : null }; },
    legacy: () => new FileInstallationIdentityStore(config.productLayout, config.configFile.writeLockTimeoutMs, undefined, config.installation).read() };
}
