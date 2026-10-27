import { SIWC_INFERENCE, listSiwcModels } from '#adapters/index.js';
import { withConfiguredSiwc } from '#composition/core/siwc/index.js';
import { recordConfiguredProviderFailure } from '#composition/core/provider-catalog/index.js';
import { ModelCatalogPolicyAuthorization, ModelConnectError } from '#engine/index.js';
import { PROVIDER_CONNECT_REGISTRY, discoverProviderModels, discoveredProviderCatalog, probeLocalToolCalls, providerDiscoveryChannel, providerConnectSecretName,
  providerProbeBase, connectionAdapter, providerConnectModelPriced, ProviderModelListError, ProviderConnectError, ProviderProbeError, listKindProviderWorkspaces,
  type ProviderConnectRegistry, type ProviderProbeOptions } from '#adapters/index.js';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { projectCredentialResolver } from '#composition/core/secrets/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

export type ModelDiscoveryHost = Readonly<{ registry?: ProviderConnectRegistry; discoveryOptions?: ProviderProbeOptions & { readonly workspaceId?: string } }>;
/** Read-only provider selection. Scope membership and the existing model-catalog inspect policy precede network and secret resolution. */
export async function listConfiguredConnectionModels(projectRoot: string, scopeId: string, connection: string, endpoint: string | null,
  options: ConfigLoadOptions = {}, host: ModelDiscoveryHost = {}) {
  try {
    const registry = host.registry ?? PROVIDER_CONNECT_REGISTRY, kind = registry.kinds.find(row => row.id === connection);
    if (!kind || !kind.connect) throw new ModelConnectError('MODEL_CONNECT_NOT_CONNECTABLE');
    const base = providerProbeBase(kind, endpoint), channelId = kind.connect.seed ?? providerDiscoveryChannel(kind, base);
    const context = await loadConfiguredScopeContext(projectRoot, scopeId, options, 'read');
    const authorize = () => new ModelCatalogPolicyAuthorization({ async load() {
      return (await loadConfiguredScopeContext(projectRoot, scopeId, options, 'read')).document;
    } }).authorize('inspect', scopeId, { channelId, modelId: null }, context.principal, 'scope');
    await authorize();
    if (kind.connect.adapter === SIWC_INFERENCE.adapter.id) {
      const rows = await withConfiguredSiwc(projectRoot, scopeId, options, 'inspect', async (app, caller) => {
        const connections = (await app.list()).filter(row => row.planUse);
        if (connections.length !== 1) throw ErrorRegistry.createError('OAUTH_CONNECTION_REAUTHORIZE');
        return listSiwcModels(signal => app.lease(connections[0]!.connectionId, caller, signal), host.discoveryOptions?.signal);
      });
      await authorize(); return rows.map(row => ({ nativeId: row.slug, displayName: row.display_name, priced: true }));
    }
    const secure = new URL(base).protocol === 'https:', name = providerConnectSecretName(kind, base);
    const key = secure && name ? await projectCredentialResolver(context, scopeId, options).resolve(name) ?? null : null;
    await authorize();
    const ids = await discoverProviderModels(kind, base, key, host.discoveryOptions);
    await authorize();
    return ids.map(nativeId => ({ nativeId, displayName: nativeId, priced: providerConnectModelPriced(kind, nativeId, base) }));
  } catch (error) {
    if (error instanceof ProviderModelListError) { await recordConfiguredProviderFailure(projectRoot, 'model-discovery', error, options);
      throw ErrorRegistry.createError(error.code, { params: { cause: error.cause, status: error.status ?? '', address: error.address ?? '' } }); }
    if (error instanceof ModelConnectError || error instanceof ProviderConnectError || error instanceof ProviderProbeError) {
      throw ErrorRegistry.createError(error.code);
    }
    throw queryFailure(error);
  }
}
/** No mutation until the selected id is still listed and the existing adapter's tariff gate accepts it. */
export async function discoverConfiguredConnectionModel(projectRoot: string, scopeId: string, connection: string, endpoint: string, nativeId: string,
  options: ConfigLoadOptions, host: ModelDiscoveryHost) {
  const registry = host.registry ?? PROVIDER_CONNECT_REGISTRY, kind = registry.kinds.find(row => row.id === connection)!;
  // Fail closed before network for an unpriced remote model (same adapter gate as the written invocation profile).
  connectionAdapter(kind, { endpoint: `${endpoint}${kind.connect!.chatPath}`, nativeId, credentialRef: providerConnectSecretName(kind, endpoint),
    maxOutputTokens: registry.profileDefaults.maxOutputTokens, currency: registry.profileDefaults.currency });
  const models = await listConfiguredConnectionModels(projectRoot, scopeId, connection, endpoint, options, host);
  if (!models.some(model => model.nativeId === nativeId)) throw new ModelConnectError('MODEL_CONNECT_MODEL_UNKNOWN');
  return discoveredProviderCatalog(kind, endpoint, nativeId, await probeLocalToolCalls(kind, endpoint, nativeId, host.discoveryOptions)); // AYSE-16: tools only when the server accepts them
}

/** Same catalog inspection gate and credential custody as model discovery; no key reaches the surface. */
export async function listConfiguredConnectionWorkspaces(root: string, scopeId: string, connection: string, endpoint: string | null, options: ConfigLoadOptions = {}, host: ModelDiscoveryHost = {}) {
  const kind = (host.registry ?? PROVIDER_CONNECT_REGISTRY).kinds.find(row => row.id === connection);
  if (!kind?.connect?.workspaceList || !kind.connect.seed) throw ErrorRegistry.createError('MODEL_CONNECT_NOT_CONNECTABLE');
  const context = await loadConfiguredScopeContext(root, scopeId, options, 'read');
  const authorize = () => new ModelCatalogPolicyAuthorization({ load: async () => (await loadConfiguredScopeContext(root, scopeId, options, 'read')).document })
    .authorize('inspect', scopeId, { channelId: kind.connect!.seed!, modelId: null }, context.principal, 'scope');
  await authorize();
  const base = providerProbeBase(kind, endpoint), name = providerConnectSecretName(kind, base);
  const key = name ? await projectCredentialResolver(context, scopeId, options).resolve(name) : undefined;
  await authorize();
  const rows = await listKindProviderWorkspaces(kind, base, key ?? '', host.discoveryOptions);
  await authorize(); return rows;
}
