import { registerProviderConfig, sealExtensionRegistries } from '#adapters/index.js';
import { approvalAssuranceProducerRegistry, environmentProbeRegistry, mcpCapabilityRegistry, providerSpendNoChargeRegistry, providerSpendPeriodRegistry } from '#engine/index.js';
import { assertErrorRegistry, loadConfig, type ConfigLoadOptions, type ResolvedConfig } from '#platform/index.js';
/** Checks the error registry once and seals add-only distribution registries before config reads; registration grants no operation authority. */
export function composeCore(): void { assertErrorRegistry(); sealExtensionRegistries(); registerProviderConfig(); mcpCapabilityRegistry.seal(); providerSpendNoChargeRegistry.seal(); providerSpendPeriodRegistry.seal(); approvalAssuranceProducerRegistry.seal(); environmentProbeRegistry.seal(); }
/** Every composed configuration read goes through the root, so the sections it validates against are always complete. */
export function loadComposedConfig(projectRoot: string, options: ConfigLoadOptions = {}): Promise<ResolvedConfig> { composeCore(); return loadConfig(projectRoot, options); }
