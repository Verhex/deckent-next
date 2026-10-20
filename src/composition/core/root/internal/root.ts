import { registerProviderConfig } from '#adapters/index.js';
import { approvalAssuranceProducerRegistry, environmentProbeRegistry, mcpCapabilityRegistry, providerSpendNoChargeRegistry } from '#engine/index.js';
import { loadConfig, type ConfigLoadOptions, type ResolvedConfig } from '#platform/index.js';
/** Seals add-only distribution registries before config reads; registration grants no operation authority. */
export function composeCore(): void { registerProviderConfig(); mcpCapabilityRegistry.seal(); providerSpendNoChargeRegistry.seal(); approvalAssuranceProducerRegistry.seal(); environmentProbeRegistry.seal(); }
/** Every composed configuration read goes through the root, so the sections it validates against are always complete. */
export function loadComposedConfig(projectRoot: string, options: ConfigLoadOptions = {}): Promise<ResolvedConfig> { composeCore(); return loadConfig(projectRoot, options); }
