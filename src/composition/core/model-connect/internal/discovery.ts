import { ModelCatalogPolicyAuthorization, ModelConnectError } from '#engine/index.js';
import { PROVIDER_CONNECT_REGISTRY, discoverProviderModels, discoveredProviderCatalog, providerDiscoveryChannel, providerConnectSecretName,
  providerProbeBase, connectionAdapter, providerConnectModelPriced, ProviderModelListError, ProviderConnectError, ProviderProbeError,
  type ProviderConnectRegistry, type ProviderProbeOptions } from '#adapters/index.js';
import { configuredSecretResolver, ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

export type ModelDiscoveryHost = Readonly<{ registry?: ProviderConnectRegistry; discoveryOptions?: ProviderProbeOptions }>;
/** Read-only provider selection. Scope membership and the existing model-catalog inspect policy precede network and secret resolution. */
export async function listConfiguredConnectionModels(projectRoot: string, scopeId: string, connection: string, endpoint: string | null,
  options: ConfigLoadOptions = {}, host: ModelDiscoveryHost = {}) {
  try {
    const registry = host.registry ?? PROVIDER_CONNECT_REGISTRY, kind = registry.kinds.find(row => row.id === connection);
    if (!kind || !kind.connect || kind.connect.seed !== null) throw new ModelConnectError('MODEL_CONNECT_NOT_CONNECTABLE');
    const base = providerProbeBase(kind, endpoint), channelId = providerDiscoveryChannel(kind, base);
    const context = await loadConfiguredScopeContext(projectRoot, scopeId, options, 'read');
    const authorize = () => new ModelCatalogPolicyAuthorization({ async load() {
      return (await loadConfiguredScopeContext(projectRoot, scopeId, options, 'read')).document;
    } }).authorize('inspect', scopeId, { channelId, modelId: null }, context.principal, 'scope');
    await authorize();
    const secure = new URL(base).protocol === 'https:', name = providerConnectSecretName(kind, base);
    const key = secure && name ? await configuredSecretResolver(context.config, options)(name) ?? null : null;
    await authorize();
    const ids = await discoverProviderModels(kind, base, key, host.discoveryOptions);
    await authorize();
    return ids.map(nativeId => ({ nativeId, displayName: nativeId, priced: providerConnectModelPriced(kind, nativeId, base) }));
  } catch (error) {
    if (error instanceof ModelConnectError || error instanceof ProviderModelListError || error instanceof ProviderConnectError || error instanceof ProviderProbeError) {
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
  return discoveredProviderCatalog(kind, endpoint, nativeId);
}
