import { relocateConfiguredProjectAttachment } from '#composition/core/attachment-lifecycle/index.js';
import { applyConfiguredProviderSpendTemplate } from '#composition/core/provider-spend/index.js';
import { inspectModelUsePreparation } from '#composition/core/model-use/index.js';
import { configuredInvocationProfiles, modelInvocationBillingAxis, ProjectAttachmentApplication } from '#engine/index.js';
import { grantConfiguredModelUse, revokeConfiguredModelUse } from '#composition/core/model-use-grant/index.js';
import { composeCore, loadComposedConfig } from '#composition/core/root/index.js';
import { configuredAttachmentStore, inspectConfiguredInstallationSource, loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { localProjectAttachmentPorts, readAttachmentBootstrapConfig, withSideEffectFreeSqliteReads } from '#adapters/index.js';
import { projectAttachmentCommandSchema } from '#domain/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { applyPolicyTemplateInstallation } from './policy-template.js';
export async function configuredProjectAttachment(root: string, options: ConfigLoadOptions = {}) {
  composeCore(); const config = await readAttachmentBootstrapConfig(root, options), store = configuredAttachmentStore(config, options);
  return new ProjectAttachmentApplication({ store, ...localProjectAttachmentPorts(config, options, store),
    observe: work => withSideEffectFreeSqliteReads(config.installation.packageMeasurement.maxTotalBytes, work),
    verify: async attachment => { const context = await loadConfiguredScopeContext(root, attachment.scopeId, { ...options, force: true }, 'read'); await context.path(); return { status: 'existing' }; },
    preparation: async source => (await inspectModelUsePreparation(source.projectRoot, source.scopeId, options)).preparation,
    source: (root, scope, actor) => inspectConfiguredInstallationSource(root, scope, actor, options),
    install: (attachment, identity) => applyPolicyTemplateInstallation(root, attachment.scopeId, options, { attachment, identity }) });
}
export async function executeConfiguredProjectAttachment(root: string, input: unknown, options: ConfigLoadOptions = {}) {
  const command = projectAttachmentCommandSchema.parse(input), app = await configuredProjectAttachment(root, options);
  const complete = async (result: Awaited<ReturnType<typeof app.apply>>) => {
      const modelLease = await grantConfiguredModelUse(root, result.attachment.scopeId, options, result.preparation?.digest);
      const config = await loadComposedConfig(root, options), registration = await configuredAttachmentStore(config, options).registration();
      const metered = configuredInvocationProfiles(config).some(profile => profile.scopeId === result.attachment.scopeId && modelInvocationBillingAxis(profile) === 'metered');
      const budget = metered && registration ? await applyConfiguredProviderSpendTemplate(root, result.attachment.scopeId,
        { root: registration.source.projectRoot, scopeId: registration.source.scopeId }, options) : { status: 'not-metered' };
      return { ...result, modelLease, budget }; };
  switch (command.action) {
    case 'register-preview': return app.registrationPreview(root, command.scopeId);
    case 'register': return app.register(root, command.scopeId, command.expect);
    case 'preview': return app.preview(command.scopeId);
    case 'offer': return app.offer(command.scopeId);
    case 'apply': return complete(await app.apply(command.scopeId, command.expect, command.commandId));
    case 'restore': return complete(await app.restore(command.projectId, command.expect));
    case 'revoke': return app.revoke(command.projectId);
    case 'lease-revoke': return revokeConfiguredModelUse(root, command.projectId, options);
    case 'detach': return app.detach(command.projectId);
    case 'unregister': return app.unregister();
    case 'relocate': return relocateConfiguredProjectAttachment(root, command.scopeId, options);
  }
}
/** First witnessed installation only; legacy sources still require the explicit register command. */
export async function registerFreshInstallation(root: string, scopeId: string, options: ConfigLoadOptions) {
  const config = await readAttachmentBootstrapConfig(root, options);
  if (await configuredAttachmentStore(config, options).registration()) return { status: 'kept' as const };
  try {
    const app = await configuredProjectAttachment(root, options), preview = await app.registrationPreview(root, scopeId);
    await app.register(root, scopeId, preview.planDigest);
    return { status: 'registered' as const };
  } catch (error) { if ((error as { code?: unknown }).code === 'AUTHORITY_WITNESS_REQUIRED') return { status: 'witness-required' as const }; throw error; }
}
