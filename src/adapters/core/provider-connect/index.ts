export { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ PROVIDER_CONNECT_ADAPTERS, PROVIDER_CONNECT_KINDS, PROVIDER_CONNECT_LEGACY_KEYS, PROVIDER_CONNECT_LIMITS, PROVIDER_CONNECT_REGISTRY, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ PROVIDER_CONNECT_REGISTRY_VERSION, parseProviderConnectRegistry, providerConnectKind,
  providerConnectSecretName, providerEndpoint, type ProviderConnectKind, type ProviderConnectRegistry, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type ProviderEndpointRefusal } from './internal/registry.js';
export { PROVIDER_PROBE_OUTCOMES, ProviderProbeError, probeProviderConnection, providerProbeBase, providerProbeRejection, type ProviderProbeFetch, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type ProviderProbeInput,
  type ProviderProbeOptions, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type ProviderProbeOutcome, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type ProviderProbeRejection, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type ProviderProbeResult } from './internal/probe.js';
export { ProviderConnectError, connectionAdapter, providerConnectFamily, providerConnectModelPriced, readProviderConnectSeed, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type ConnectionAdapter } from './internal/profile.js';
export { providerProfileCacheOffer, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type ProviderProfileCacheOffer } from './internal/cache.js';
export { providerProfileProtocolOffer, type ProviderProfileProtocolDetail } from './internal/protocol.js';
export { providerRequestDiagnosis } from './internal/diagnosis.js';
export { listProviderWorkspaces, listKindProviderWorkspaces, providerProfileWorkspaceOffer, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type ProviderWorkspace } from './internal/workspaces.js';
export { discoverProviderModels, discoveredProviderCatalog, probeLocalToolCalls, providerDiscoveryChannel, ProviderModelListError } from './internal/discovery.js';

export type { ProviderDiscoveryCause } from './internal/failure.js';
export { providerConnectHelpKinds } from './help.js';
export { terminalTextChatFamilies } from './internal/registry.js';
