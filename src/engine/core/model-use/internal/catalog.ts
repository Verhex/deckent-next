import { verifiedPrincipal } from '#engine/core/authentication/index.js';
import type { ModelInvocationProfile } from '#domain/index.js';
import { ModelCatalogApplication } from '#engine/core/model-activation/index.js';
import { ModelCatalogPolicyAuthorization } from '#engine/core/policy/index.js';
import type { ModelUseContext, ModelUseWritePorts } from './ports.js';
/** Copy public catalog facts through their owner, never credentials or source balances. */
export async function carryModelUseCatalog(ports: ModelUseWritePorts, source: ModelUseContext, target: ModelUseContext, profiles: readonly ModelInvocationProfile[], leaseId: string) {
  const reader = await ports.catalogReader(source), scopeId = target.principal.scopeIds[0]!;
  const app = new ModelCatalogApplication(verifiedPrincipal(target.principal), new ModelCatalogPolicyAuthorization({ load: async () => target.document }),
    () => ports.catalogStore(target), Date.now, () => ports.catalogReader(target));
  try {
    for (const profile of profiles) {
      const channel = await reader.channel(profile.reference.providerId);
      const row = (await reader.models(profile.reference.providerId)).find(item => item.model.id === profile.reference.modelId && item.model.version === profile.reference.modelVersion);
      if (!channel || !row || (await reader.activation(source.principal.scopeIds[0]!, channel.channelId, null))?.state !== 'active'
        || (await reader.activation(source.principal.scopeIds[0]!, channel.channelId, row.modelId))?.state !== 'active') continue;
      const commandId = `${leaseId}.${profile.id}.catalog`;
      await app.apply({ schemaVersion: 1, action: 'register', scopeId, commandId, catalog: { schemaVersion: 'client' in channel.channel ? 3 : 2,
        revision: commandId, providers: [{ id: channel.channelId, version: channel.providerVersion, channel: channel.channel, models: [row.model] }] } });
      for (const modelId of [null, row.modelId]) {
        const targetReader = await ports.catalogReader(target);
        let before; try { before = await targetReader.activation(scopeId, channel.channelId, modelId); } finally { targetReader.close(); }
        if (before?.state === 'active') continue;
        await app.apply({ schemaVersion: 1, action: 'activate', scopeId, commandId: `${commandId}.${modelId === null ? 'channel' : 'model'}`,
          channelId: channel.channelId, modelId, expectedRevision: before?.revision ?? 0 });
      }
    }
  } finally { reader.close(); }
}
