import { createHash } from 'node:crypto';
import { PROVIDER_CONNECT_REGISTRY, providerConnectModelPriced } from '#adapters/index.js';
import { admitConfiguredChatActivation } from './admit.js';
import { inspectModelBinding, inspectDeclaredModels } from '#composition/core/provider-catalog/index.js';
import { ModelCatalogError, modelCatalogCommandSchema, type ModelCatalogQuery } from '#domain/index.js';
import { planCatalogStateCascade, ModelCatalogApplication, ModelCatalogPolicyAuthorization } from '#engine/index.js';
import { openSqliteModelCatalogReader, openSqliteModelCatalogStore } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { inspectConfiguredModelActivation } from './inspect.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

/** Governed ledger model catalog write (WORKER-CURRENCY-1): register facts, activate/deactivate a channel or model in a scope. */
export async function applyConfiguredModelCatalogOnly(projectRoot: string, input: unknown, options: ConfigLoadOptions = {}) {
  try {
    const parsed = modelCatalogCommandSchema.safeParse(input);
    if (!parsed.success) throw new ModelCatalogError('MODEL_CATALOG_INVALID');
    return await (await catalog(projectRoot, parsed.data.scopeId, options, 'write')).apply(parsed.data);
  } catch (error) { throw queryFailure(error); }
}
export async function inspectConfiguredModelCatalog(projectRoot: string, query: ModelCatalogQuery, options: ConfigLoadOptions = {}) { // read-only listing (WORKER-CURRENCY-2)
  try {
    const result = await (await catalog(projectRoot, query.scopeId, options, 'read')).inspect(query);
    const { config } = await loadConfiguredScopeContext(projectRoot, query.scopeId, options, 'read');
    if (!config.provider_catalog) return result;
    const declared = (await inspectDeclaredModels(projectRoot, options)).catalog;
    if (!declared) return result;
    return { ...result, channels: await Promise.all(result.channels.map(async channel => {
      if (channel.access !== 'allowed') return channel;
      const provider = declared.providers.find(provider => provider.id === channel.channelId && provider.version === channel.providerVersion);
      return { ...channel, models: await Promise.all(channel.models.map(async entry => {
        const model = provider?.models.find(model => model.nativeId === entry.modelId);
        if (!model) return entry;
        const chat = await inspectConfiguredModelActivation(projectRoot, { schemaVersion: 1, scopeId: query.scopeId,
          reference: { providerId: provider!.id, providerVersion: provider!.version, modelId: model.id, modelVersion: model.version } }, options);
        const chatState = chat.activation?.state ?? null;
        return { ...entry, chatState, activationConflict: (chatState === 'active') !== (channel.activation?.state === 'active' && entry.activation?.state === 'active') };
      })) };
    })) };
  } catch (error) { throw queryFailure(error); }
}
async function catalog(projectRoot: string, scopeId: string, options: ConfigLoadOptions, access: 'read' | 'write') {
  const { config, document, principal, path } = await loadConfiguredScopeContext(projectRoot, scopeId, options, access);
  return new ModelCatalogApplication({ async verify() { return principal; } }, new ModelCatalogPolicyAuthorization({ async load() { return document; } }),
    async () => openSqliteModelCatalogStore(await path(), config.storage.sqlite, 'forbid'), Date.now, async () => openSqliteModelCatalogReader(await path(), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs }));
}

/** Person-facing catalog activation also aligns declared chat rows; raw catalog and chat owners retain separate receipts. */
export async function applyConfiguredModelCatalog(root: string, input: unknown, options: ConfigLoadOptions = {}) {
  const parsed = modelCatalogCommandSchema.safeParse(input);
  if (!parsed.success) throw queryFailure(new ModelCatalogError('MODEL_CATALOG_INVALID'));
  const command = parsed.data;
  if (command.action === 'register') return applyConfiguredModelCatalogOnly(root, command, options);
  const before = await inspectConfiguredModelCatalog(root, { schemaVersion: 1, scopeId: command.scopeId, channelId: command.channelId }, options);
  const channel = before.channels.find(row => row.access === 'allowed');
  const result = await applyConfiguredModelCatalogOnly(root, command, options);
  if (channel?.access !== 'allowed') return result;
  if (result.replayed) return result;
  const declared = (await inspectDeclaredModels(root, options)).catalog?.providers.find(provider => provider.id === channel.channelId && provider.version === channel.providerVersion);
  const kind = PROVIDER_CONNECT_REGISTRY.kinds.find(kind => kind.connect?.seed === channel.channelId);
  const child = (id: string, stage: string) => `catalog-state-${createHash('sha256').update(JSON.stringify([command.commandId, id, stage])).digest('hex')}`;
  if (command.action === 'activate' && command.modelId !== null && channel.activation?.state !== 'active') await applyConfiguredModelCatalogOnly(root, { schemaVersion: 1, commandId: child('channel', 'activate'), scopeId: command.scopeId, action: 'activate', channelId: channel.channelId, modelId: null, expectedRevision: channel.activation?.revision ?? 0 }, options);
  const priced = kind ? channel.models.filter(row => providerConnectModelPriced(kind, row.model.nativeId)).map(row => row.modelId) : [];
  for (const { entry, enabled, activateWorker, reference } of planCatalogStateCascade(command, channel, declared, priced)) {
    if (activateWorker) await applyConfiguredModelCatalogOnly(root, { schemaVersion: 1, commandId: child(entry.modelId, 'worker'), scopeId: command.scopeId,
      action: 'activate', channelId: channel.channelId, modelId: entry.modelId, expectedRevision: 0 }, options);
    if (!reference) continue;
    const current = await inspectConfiguredModelActivation(root, { schemaVersion: 1, scopeId: command.scopeId, reference }, options);
    if (current.activation?.state === (enabled ? 'active' : 'inactive') || !current.activation && !enabled) continue;
    const binding = await inspectModelBinding(root, reference, options);
    if (binding.status !== 'declared') continue;
    await admitConfiguredChatActivation(root, { schemaVersion: 1, commandId: child(entry.modelId, 'chat'), scopeId: command.scopeId, reference,
      expectedRevision: current.activation?.revision ?? 0, expectedBinding: binding.binding,
      ...(enabled ? { action: 'activate', catalogRevision: binding.catalogRevision } : { action: 'deactivate' }) }, options);
  }
  return result;
}
