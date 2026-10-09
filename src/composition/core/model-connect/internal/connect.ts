import type { ModelConnectResult } from '#domain/index.js';
import { AuditApplication, ModelConnectApplication, ModelConnectError, assessModelInvocationProfileDeliveries, configServiceState, planProfileCache, type DescribeService,
  type ProfileCachePlan } from '#engine/index.js';
import { PROVIDER_CONNECT_REGISTRY, ProviderConnectError, connectionAdapter, openLocalIntegrityAuthority, openSqliteAuditStore, providerConnectSecretName,
  providerEndpoint, providerProfileCacheOffer, readProviderConnectSeed, type ProviderConnectRegistry } from '#adapters/index.js';
import { DeckentError, ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal, snapshotConfiguredConfig } from '#composition/core/config/index.js';
import { inspectModelBinding } from '#composition/core/provider-catalog/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { configuredModelInvocationDeliverySurfaces } from '#composition/core/model-invocation/index.js';
import { admitConfiguredModelActivation, applyConfiguredModelCatalog, inspectConfiguredModelActivation, inspectConfiguredModelCatalog } from '#composition/core/model-activation/index.js';
import { discoverConfiguredConnectionModel, type ModelDiscoveryHost } from './discovery.js';

/** Code-only host ports (never config or environment): the secret names (to report the key's presence), the service describe (restart state), and a
 * registry document in place of the shipped one (tests, an Enterprise overlay through the same schema). */
export type ModelConnectHost = ModelDiscoveryHost & Readonly<{ registry?: ProviderConnectRegistry;
  listSecretNames?: (root: string, options: ConfigLoadOptions) => Promise<Readonly<{ names: readonly string[] }>>; describeService?: DescribeService }>;

/**
 * `models.connect` (T4-B D2) as the CLI, SDK, MCP and the terminal call it: the engine's `ModelConnectApplication` over the configured governed
 * owners — the `/config` writer (policy, approval, audit), the ledger catalog register, the chat activation, the audit log — and the
 * provider-connect registry (kinds, seeds, adapters). Seedless discovery resolves the configured key behind its HTTPS reader;
 * the engine and the command/result never receive a key value.
 */
export async function connectConfiguredModel(projectRoot: string, input: unknown, options: ConfigLoadOptions = {}, host: ModelConnectHost = {}): Promise<ModelConnectResult> {
  try {
    const registry = host.registry ?? PROVIDER_CONNECT_REGISTRY, scopeId = (input as { scopeId?: unknown } | null)?.scopeId;
    const kindOf = (id: string) => registry.kinds.find(kind => kind.id === id) ?? null;
    const config = createConfiguredConfigApplication(projectRoot, options);
    const principal = typeof scopeId === 'string' ? () => resolveConfiguredConfigPrincipal(projectRoot, scopeId, options) : () => { throw new ModelConnectError('MODEL_CONNECT_INVALID'); };
    const scope = () => loadConfiguredScopeContext(projectRoot, String(scopeId), options, 'write');
    // The merged configuration of the last layer read: its result frames bound a connected profile's answer.
    let effective: Record<string, unknown> = {};
    const app = new ModelConnectApplication({
      kind: id => { const kind = kindOf(id); return kind && { id: kind.id, available: kind.available, endpoint: kind.endpoint, keyRequired: kind.key?.required ?? false, connect: kind.connect }; },
      defaults: registry.profileDefaults,
      endpoint: text => { const checked = providerEndpoint(text); return checked.ok ? checked.base : null; },
      secretName: (id, base) => { const kind = kindOf(id); return kind ? providerConnectSecretName(kind, base) : null; },
      seed: readProviderConnectSeed,
      discover: (id, base, nativeId) => discoverConfiguredConnectionModel(projectRoot, String(scopeId), id, base, nativeId, options, host),
      adapter: (id, value) => connectionAdapter(kindOf(id)!, value),
      principal,
      async layers() {
        const snapshot = await snapshotConfiguredConfig(projectRoot, options); effective = snapshot.effective as never;
        return { global: snapshot.global, project: snapshot.project, effective };
      },
      async write(change) {
        const outcome = await config.submit('set', { ...change, principal: await principal(), scopeId: String(scopeId) });
        return outcome.status === 'approval-pending' ? { approvalId: outcome.approval.approvalId } : null;
      },
      async catalogHas(channelId, nativeId) {
        const listed = await inspectConfiguredModelCatalog(projectRoot, { schemaVersion: 1, scopeId: String(scopeId), channelId }, options);
        return listed.channels.some(channel => channel.channelId === channelId && channel.access !== 'denied' && channel.models.some(entry => entry.model.nativeId === nativeId));
      },
      async register(catalog, commandId) { await applyConfiguredModelCatalog(projectRoot, { schemaVersion: 1, commandId, scopeId, action: 'register', catalog }, options); },
      binding: reference => inspectModelBinding(projectRoot, reference, options),
      async activation(reference) { return (await inspectConfiguredModelActivation(projectRoot, { schemaVersion: 1, scopeId: String(scopeId), reference }, options)).activation; },
      async activate(value) {
        await admitConfiguredModelActivation(projectRoot, { schemaVersion: 1, action: 'activate', commandId: value.commandId, scopeId: String(scopeId), reference: value.reference,
          expectedRevision: value.expectedRevision, catalogRevision: value.catalogRevision, expectedBinding: { encodingVersion: 1, algorithm: 'sha256', digest: value.digest } }, options);
      },
      delivers: (profile, binding) => assessModelInvocationProfileDeliveries([{ profile: profile as never, definition: binding.definition, catalogRevision: binding.catalogRevision }],
        configuredModelInvocationDeliverySurfaces(effective as never)).length === 0,
      async audit(event) {
        const context = await scope(), store = await openSqliteAuditStore(await context.path(), context.config.storage.sqlite, 'forbid');
        try { new AuditApplication(store, await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, true)).record(event); } finally { store.close(); }
      },
      async policyRevision() { return (await scope()).document.revision; },
      async keyStored(name) { if (!host.listSecretNames) return null; try { return (await host.listSecretNames(projectRoot, options)).names.includes(name); } catch { return null; } },
      service: () => configServiceState(projectRoot, options, host.describeService),
    });
    return await app.connect(input);
  } catch (error) {
    if (error instanceof ModelConnectError || error instanceof ProviderConnectError) throw ErrorRegistry.createError(error.code);
    throw error instanceof DeckentError ? error : queryFailure(error);
  }
}

/** CACHE-SLICE1: the scope's existing profiles the adapter offers the 5-minute prompt cache for, and the per-layer writes (read fresh; nothing written
 * here — the caller sends each write through the governed `/config` writer, so policy, approval and audit stay that writer's). */
export async function planConfiguredProfileCache(projectRoot: string, scopeId: string, options: ConfigLoadOptions = {}): Promise<ProfileCachePlan> {
  const snapshot = await snapshotConfiguredConfig(projectRoot, options);
  return planProfileCache({ global: snapshot.global as Record<string, unknown>, project: snapshot.project as Record<string, unknown> }, scopeId, providerProfileCacheOffer);
}
