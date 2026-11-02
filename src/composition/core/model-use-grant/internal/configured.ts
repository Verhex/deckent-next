import { isDeepStrictEqual } from 'node:util';
import { attachmentFailure, grantModelUse, revokeModelUse, type ModelUseWritePorts } from '#engine/index.js';
import { localProjectAttachmentPorts, openSqliteModelActivationStore, openSqliteModelCatalogStore } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { modelUseReadPorts } from '#composition/core/model-use/index.js';
import { createConfiguredConfigApplication, snapshotConfiguredConfig } from '#composition/core/config/index.js';
import { configuredAttachmentStore } from '#composition/core/scoped-request/index.js';
function ports(options: ConfigLoadOptions): ModelUseWritePorts {
  return { ...modelUseReadPorts(options),
    authorize: async config => { const local = localProjectAttachmentPorts(config, options, configuredAttachmentStore(config, options)); await local.authorize(); return local.actor; },
    async write(context, keyPath, value, commandId) { const root = context.config.projectRoot, snapshot = await snapshotConfiguredConfig(root, options);
      if (isDeepStrictEqual(snapshot.project[keyPath], value)) return;
      const result = await createConfiguredConfigApplication(root, options).submit('set', { keyPath, value, commandId, layer: 'project',
        scopeId: context.principal.scopeIds[0]!, principal: context.principal, expect: snapshot.digest });
      if (result.status !== 'applied') return attachmentFailure('PROJECT_ATTACHMENT_INCOMPLETE'); },
    catalogStore: async context => openSqliteModelCatalogStore(await context.path(), context.config.storage.sqlite, 'forbid'),
    activationStore: async context => openSqliteModelActivationStore(await context.path(), context.config.storage.sqlite, 'forbid'),
  };
}
export const grantConfiguredModelUse = (root: string, scopeId: string, options: ConfigLoadOptions = {}, expected?: string) => grantModelUse(ports(options), root, scopeId, expected);
export const revokeConfiguredModelUse = (root: string, projectId: string, options: ConfigLoadOptions = {}) => revokeModelUse(ports(options), root, projectId);
