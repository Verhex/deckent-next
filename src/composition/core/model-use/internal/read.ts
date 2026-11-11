import { ModelBindingApplication, resolveModelUse, inspectModelUsePreparation as inspectPreparation, type ModelUseReadPorts } from '#engine/index.js';
import { openSqliteModelActivationReader, openSqliteModelCatalogReader, createConfigFileDocuments, resolveTerminalModel } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import type { ModelInspectionSnapshot } from '#composition/core/model-inspection/index.js';
import { loadConfiguredScopeContext, configuredAttachmentStore, configuredInstallationProjectContext } from '#composition/core/scoped-request/index.js';
export function modelUseReadPorts(options: ConfigLoadOptions, snapshot?: ModelInspectionSnapshot): ModelUseReadPorts {
  return { binding: async (context, reference) => snapshot ? (await snapshot.catalogFor(context.config)).bindings.inspect(reference) : new ModelBindingApplication({ read: async () => context.config['provider_catalog'] }).inspect(reference),
    config: root => snapshot ? snapshot.configFor(root) : loadComposedConfig(root, { ...options, force: true, heal: false }),
    context: (root, scopeId) => snapshot ? snapshot.contextFor(root, scopeId) : loadConfiguredScopeContext(root, scopeId, { ...options, force: true, heal: false }, 'read'),
    shared: (config, scopeId, actor) => configuredInstallationProjectContext(config, options, scopeId, actor, snapshot?.inspectSource),
    store: config => configuredAttachmentStore(config, options), selection: async context => resolveTerminalModel(await (snapshot ? snapshot.documentsFor(context.config.projectRoot) : createConfigFileDocuments(context.config.projectRoot, options).snapshot('project')))?.reference ?? null,
    catalogReader: async context => openSqliteModelCatalogReader(await context.path(), { busyTimeoutMs: context.config.storage.sqlite.busyTimeoutMs }),
    async activation(context, scopeId, reference) { const reader = await openSqliteModelActivationReader(await context.path(), { busyTimeoutMs: context.config.storage.sqlite.busyTimeoutMs });
      try { return await reader.loadRecord(scopeId, reference); } finally { reader.close(); } },
  };
}
export const resolveConfiguredModelUse = (root: string, profile: Parameters<typeof resolveModelUse>[2], actor: Parameters<typeof resolveModelUse>[3], options: ConfigLoadOptions = {}, snapshot?: ModelInspectionSnapshot) =>
  resolveModelUse(modelUseReadPorts(options, snapshot), root, profile, actor);
export const inspectConfiguredModelUse = (root: string, profile: Parameters<typeof resolveModelUse>[2], actor: Parameters<typeof resolveModelUse>[3], options: ConfigLoadOptions = {}, snapshot?: ModelInspectionSnapshot) =>
  resolveModelUse(modelUseReadPorts(options, snapshot), root, profile, actor, { action: 'inspect' });
export const inspectModelUsePreparation = (root: string, scopeId: string, options: ConfigLoadOptions = {}) => inspectPreparation(modelUseReadPorts(options), root, scopeId);
