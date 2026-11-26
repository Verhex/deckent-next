import { optionalField } from '#platform/index.js';

import { loadComposedConfig } from '#composition/core/root/index.js';
import { contextPolicySource } from '#composition/core/policy/index.js';
import { inspectInstallationSourceFiles, localInstallationProjectContextPorts, FileProjectAttachmentStore } from '#adapters/index.js';
import { resolveInstallationProjectContext } from '#engine/index.js';
import type { ConfigLoadOptions, ProductLayout, ResolvedConfig } from '#platform/index.js';
import { resolveConfiguredScopeMembership } from './registry.js';
export async function inspectConfiguredInstallationSource(root: string, scopeId: string, actor: { readonly issuer: string; readonly subject: string }, options: ConfigLoadOptions) {
  const config = await loadComposedConfig(root, { ...options, heal: false, force: true });
  return inspectInstallationSourceFiles(config, scopeId, actor, async () => { const document = (await contextPolicySource({ layout: config.productLayout, config }).load());
    await resolveConfiguredScopeMembership(config, document, actor, [scopeId], 'read'); });
}
export const configuredAttachmentStore = (config: ResolvedConfig, options: ConfigLoadOptions) => new FileProjectAttachmentStore(config.productLayout, options, config.installation.profileMaxBytes, config.installation.writeLockTimeoutMs);
export async function configuredInstallationProjectContext(config: ResolvedConfig, options: ConfigLoadOptions, scopeId?: string,
  actor?: { readonly issuer: string; readonly subject: string }, inspectSource: typeof inspectConfiguredInstallationSource = inspectConfiguredInstallationSource) {
  let installationLayout: ProductLayout = config.productLayout;
  const context = await resolveInstallationProjectContext(localInstallationProjectContextPorts(config, options, async source => {
    const observed = await inspectSource(source.projectRoot, source.scopeId, actor ?? source.owner, options);
    installationLayout = observed.config.productLayout;
    return observed;
  }), { registrationId: config.installation.sharedRegistrationId ?? null, companyId: config.company.id, ...optionalField('scopeId', scopeId), ...optionalField('actor', actor) });
  return { ...context, installationLayout };
}
