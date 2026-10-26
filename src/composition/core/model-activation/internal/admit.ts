import { createHash } from 'node:crypto';
import { inspectConfiguredModelActivation } from './inspect.js';
import { inspectDeclaredModels } from '#composition/core/provider-catalog/index.js';
import { modelActivationCommandSchema, type ModelActivationCommand, type ModelReference } from '#domain/index.js';
import { ModelActivationApplication, ModelActivationPolicyAuthorization, ModelBindingApplication,
  assessModelInvocationProfileDeliveries } from '#engine/index.js';
import { openSqliteModelActivationStore } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { inspectConfiguredModelCatalog, applyConfiguredModelCatalogOnly } from './catalog.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { configuredModelInvocationDeliverySurfaces } from '#composition/core/model-invocation/index.js';

/** Explicit local activation admission, not provider invocation. Store path is resolved only after the gate. */
export async function admitConfiguredChatActivation(projectRoot: string, input: ModelActivationCommand, options: ConfigLoadOptions = {}) {
  try {
    const command = modelActivationCommandSchema.parse(input);
    const { config, document, principal, path } = await loadConfiguredScopeContext(projectRoot, command.scopeId, options, 'write');
    // Adapter selection/wiring only (SESSION-RESULT-LIMIT-2026-09-28 review): the audit decision itself — which
    // declared profiles match this reference, whether any is unfit, refuse or not — lives in
    // ModelActivationApplication.admit (engine); this composition root only resolves the two surfaces' capacity
    // and wires the real size-math implementation in as `assess` (engine/core/model-activation cannot import
    // engine/core/model-invocation directly — that package already depends back on model-activation, so a
    // direct import would cycle; composition, which depends on both, is where the two meet).
    const app = new ModelActivationApplication({ async verify() { return principal; } },
      new ModelActivationPolicyAuthorization({ async load() { return document; } }),
      new ModelBindingApplication({ async read() { return config['provider_catalog']; } }),
      async () => openSqliteModelActivationStore(await path(), config.storage.sqlite, 'forbid'), Date.now,
      { profiles: config['provider_invocation_profiles'], surfaces: configuredModelInvocationDeliverySurfaces(config),
        assess: assessModelInvocationProfileDeliveries });
    return await app.admit(command);
  } catch (error) { throw queryFailure(error); }
}

/** One explicit model command coordinates the chat and worker owners; reads never cascade. */
export async function admitConfiguredModelActivation(projectRoot: string, input: ModelActivationCommand, options: ConfigLoadOptions = {}) {
  try {
    const command = modelActivationCommandSchema.parse(input);
    const result = await admitConfiguredChatActivation(projectRoot, command, options);
    if (result.replayed) {
      const latest = await inspectConfiguredModelActivation(projectRoot, { schemaVersion: 1, scopeId: command.scopeId, reference: command.reference }, options);
      if (latest.activation?.revision !== result.receipt.record.revision) return result;
    }
    const listed = await inspectConfiguredModelCatalog(projectRoot, { schemaVersion: 1, scopeId: command.scopeId, channelId: command.reference.providerId }, options);
    const channel = listed.channels.find(row => row.access === 'allowed' && row.providerVersion === command.reference.providerVersion);
    if (channel?.access === 'allowed') {
      const declared = (await inspectDeclaredModels(projectRoot, options)).catalog?.providers.find(provider => provider.id === command.reference.providerId && provider.version === command.reference.providerVersion)?.models.find(model => model.id === command.reference.modelId && model.version === command.reference.modelVersion);
      const model = channel.models.find(row => row.model.nativeId === declared?.nativeId);
      if (model) {
        const targets = command.action === 'activate' ? [null, model.modelId] : [model.modelId];
        for (const [index, modelId] of targets.entries()) {
          const current = modelId === null ? channel.activation : model.activation;
          const wanted = command.action === 'activate' ? 'active' : 'inactive';
          if (current?.state === wanted) continue;
          await applyConfiguredModelCatalogOnly(projectRoot, { schemaVersion: 1, commandId: `model-state-${createHash('sha256').update(command.commandId).digest('hex')}-${index}`, scopeId: command.scopeId,
            action: command.action, channelId: channel.channelId, modelId, expectedRevision: current?.revision ?? 0 }, options);
        }
      }
    }
    return result;
  } catch (error) { throw queryFailure(error); }
}

/** A named worker-only model: no chat declaration/profile and no whole-channel cascade. */
export async function activateConfiguredWorkerModel(root: string, scopeId: string, reference: ModelReference, commandId: string, options: ConfigLoadOptions = {}): Promise<boolean> {
  const listed = await inspectConfiguredModelCatalog(root, { schemaVersion: 1, scopeId, channelId: reference.providerId }, options);
  const channel = listed.channels.find(row => row.access === 'allowed' && row.providerVersion === reference.providerVersion);
  if (channel?.access !== 'allowed') throw queryFailure(Object.assign(Error('MODEL_CATALOG_NOT_FOUND'), { code: 'MODEL_CATALOG_NOT_FOUND' }));
  const model = channel.models.find(row => row.model.id === reference.modelId && row.model.version === reference.modelVersion);
  if (!model) throw queryFailure(Object.assign(Error('MODEL_CATALOG_NOT_FOUND'), { code: 'MODEL_CATALOG_NOT_FOUND' }));
  let written = false;
  for (const [index, modelId] of [null, model.modelId].entries()) {
    const current = modelId === null ? channel.activation : model.activation;
    if (current?.state === 'active') continue;
    await applyConfiguredModelCatalogOnly(root, { schemaVersion: 1, commandId: `${commandId}.${index}`, scopeId, action: 'activate', channelId: reference.providerId,
      modelId, expectedRevision: current?.revision ?? 0 }, options); written = true;
  }
  return written;
}
