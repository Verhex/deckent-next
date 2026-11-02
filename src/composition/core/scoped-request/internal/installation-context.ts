import { userInfo } from 'node:os';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { FileInstallationIdentityStore, FileProjectIdentityStore, FileProjectAttachmentStore, captureAttachmentLocation } from '#adapters/index.js';
import { resolveInstallationProjectContext, attachmentFailure } from '#engine/index.js';
import { policySchema, installationSourceSchema, type InstallationSource } from '#domain/index.js';
import type { ConfigLoadOptions, ResolvedConfig } from '#platform/index.js';
import { resolveConfiguredScopeMembership } from './registry.js';

/** Reconstruct the selected source from its current configuration and policy, never from a caller-supplied layout alone. */
export async function inspectConfiguredInstallationSource(root: string, scopeId: string, actor: { readonly issuer: string; readonly subject: string }, options: ConfigLoadOptions) {
  const config = await loadComposedConfig(root, { ...options, heal: false, force: true });
  if (config.installation.sharedRegistrationId) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
  const layout = config.productLayout, location = await captureAttachmentLocation(layout.root);
  await captureAttachmentLocation(config.projectRoot);
  const document = policySchema.parse(await createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes).load());
  await resolveConfiguredScopeMembership(config, document, actor, [scopeId], 'read');
  const identity = await new FileInstallationIdentityStore(layout, config.configFile.writeLockTimeoutMs, undefined, config.installation).read();
  const project = await new FileProjectIdentityStore(config.projectRoot, config.configFile.writeLockTimeoutMs).read();
  if (identity.status !== 'available' || identity.pendingWrite || identity.value.realmSeal || project.status !== 'available') return attachmentFailure('PROJECT_ATTACHMENT_UNAVAILABLE');
  const source = installationSourceSchema.parse({ projectRoot: config.projectRoot, layoutRoot: layout.root, bootstrapConfigPath: layout.bootstrapConfigPath,
    layoutRevision: layout.revision, installationId: identity.value.installationId, projectId: project.value.projectId,
    companyId: config.company.id, scopeId, owner: { issuer: actor.issuer, subject: actor.subject }, location });
  return { source, identity, config };
}
export function configuredAttachmentStore(config: ResolvedConfig, options: ConfigLoadOptions) {
  return new FileProjectAttachmentStore(config.productLayout, options, config.installation.profileMaxBytes, config.installation.writeLockTimeoutMs);
}
export async function configuredInstallationProjectContext(config: ResolvedConfig, options: ConfigLoadOptions, scopeId?: string, actor?: { readonly issuer: string; readonly subject: string }) {
  const store = configuredAttachmentStore(config, options);
  return resolveInstallationProjectContext({ registration: () => store.registration(), attachment: () => store.attachment(),
    source: (source: InstallationSource) => inspectConfiguredInstallationSource(source.projectRoot, source.scopeId, source.owner, options),
    target: async () => { const project = await new FileProjectIdentityStore(config.projectRoot, config.configFile.writeLockTimeoutMs).read();
      return { ...await captureAttachmentLocation(config.projectRoot), projectId: project.status === 'available' ? project.value.projectId : null }; },
    legacy: () => new FileInstallationIdentityStore(config.productLayout, config.configFile.writeLockTimeoutMs, undefined, config.installation).read(),
  }, { registrationId: config.installation.sharedRegistrationId ?? null, companyId: config.company.id,
    ...(scopeId === undefined ? {} : { scopeId }), ...(actor === undefined ? {} : { actor }) });
}
