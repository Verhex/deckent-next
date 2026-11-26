import { optionalField } from '#platform/index.js';

import { loadComposedConfig } from '#composition/core/root/index.js';
import { contextPolicySource } from '#composition/core/policy/index.js';
import { inspectInstallationSourceFiles, localInstallationProjectContextPorts, FileProjectAttachmentStore } from '#adapters/index.js';
import { resolveInstallationProjectContext, type RegisteredInstallationBinding, type SourceRepairKind } from '#engine/index.js';
import type { ConfigLoadOptions, ProductLayout, ResolvedConfig } from '#platform/index.js';
import { resolveConfiguredScopeMembership } from './registry.js';
export async function inspectConfiguredInstallationSource(root: string, scopeId: string, actor: { readonly issuer: string; readonly subject: string },
  options: ConfigLoadOptions, locked?: RegisteredInstallationBinding) {
  const config = await loadComposedConfig(root, { ...options, heal: false, force: true });
  return inspectInstallationSourceFiles(config, scopeId, actor, async () => { const document = (await contextPolicySource({ layout: config.productLayout, config }).load());
    await resolveConfiguredScopeMembership(config, document, actor, [scopeId], 'read'); }, locked);
}
export const configuredAttachmentStore = (config: ResolvedConfig, options: ConfigLoadOptions) => new FileProjectAttachmentStore(config.productLayout, options, config.installation.profileMaxBytes, config.installation.writeLockTimeoutMs);
export async function configuredInstallationProjectContext(config: ResolvedConfig, options: ConfigLoadOptions, scopeId?: string, actor?: { readonly issuer: string; readonly subject: string },
  inspectSource: typeof inspectConfiguredInstallationSource = inspectConfiguredInstallationSource, admitWrite?: (checkpoint?: 'target-publication') => Promise<void>,
  onSourceRepair?: (kind: SourceRepairKind) => void) {
  let installationLayout: ProductLayout = config.productLayout;
  const write: Parameters<typeof localInstallationProjectContextPorts>[3] = admitWrite && actor ? {
    actor, ...optionalField('scopeId', scopeId), admitTarget: async repair => {
      try { await admitWrite('target-publication'); }
      catch (error) {
        if (repair) onSourceRepair?.(repair);
        throw error;
      }
    },
    loadSource: root => loadComposedConfig(root, { ...options, heal: false, force: true }),
    inspectSource: (root, scope, person, locked) => inspectSource(root, scope, person, options, locked),
    admitSource: async (source, sourceScope) => {
      await admitWrite();
      if (source.projectRoot === config.projectRoot && sourceScope === scopeId) return;
      const document = await contextPolicySource({ layout: source.productLayout, config: source }).load();
      await resolveConfiguredScopeMembership(source, document, actor, [sourceScope], 'write');
    },
  } : undefined;
  const ports = localInstallationProjectContextPorts(config, options, async source => {
    const observed = await inspectSource(source.projectRoot, source.scopeId, actor ?? source.owner, options);
    installationLayout = observed.config.productLayout;
    return observed;
  }, write);
  const context = await resolveInstallationProjectContext(ports, { registrationId: config.installation.sharedRegistrationId ?? null, companyId: config.company.id,
    ...optionalField('scopeId', scopeId), ...optionalField('actor', actor) });
  return { ...context, installationLayout };
}
