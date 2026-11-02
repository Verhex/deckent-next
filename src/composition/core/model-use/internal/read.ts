import { resolveModelUse, inspectModelUsePreparation as inspectPreparation, type ModelUseReadPorts } from '#engine/index.js';
import { openSqliteModelActivationReader, openSqliteModelCatalogReader, createConfigFileDocuments, resolveTerminalModel } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { loadConfiguredScopeContext, configuredAttachmentStore, configuredInstallationProjectContext } from '#composition/core/scoped-request/index.js';
export function modelUseReadPorts(options: ConfigLoadOptions): ModelUseReadPorts {
  return { config: root => loadComposedConfig(root, { ...options, force: true, heal: false }),
    context: (root, scopeId) => loadConfiguredScopeContext(root, scopeId, { ...options, force: true, heal: false }, 'read'),
    shared: (config, scopeId, actor) => configuredInstallationProjectContext(config, options, scopeId, actor),
    store: config => configuredAttachmentStore(config, options), selection: async context => resolveTerminalModel(await createConfigFileDocuments(context.config.projectRoot, options).snapshot('project'))?.reference ?? null,
    catalogReader: async context => openSqliteModelCatalogReader(await context.path(), { busyTimeoutMs: context.config.storage.sqlite.busyTimeoutMs }),
    async activation(context, scopeId, reference) { const reader = await openSqliteModelActivationReader(await context.path(), { busyTimeoutMs: context.config.storage.sqlite.busyTimeoutMs });
      try { return await reader.loadRecord(scopeId, reference); } finally { reader.close(); } },
  };
}
export const resolveConfiguredModelUse = (root: string, profile: Parameters<typeof resolveModelUse>[2], actor: Parameters<typeof resolveModelUse>[3], options: ConfigLoadOptions = {}) =>
  resolveModelUse(modelUseReadPorts(options), root, profile, actor);
export const inspectModelUsePreparation = (root: string, scopeId: string, options: ConfigLoadOptions = {}) => inspectPreparation(modelUseReadPorts(options), root, scopeId);
