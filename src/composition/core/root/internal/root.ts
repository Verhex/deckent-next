import { registerProviderConfig } from '#adapters/index.js';
import { mcpCapabilityRegistry } from '#engine/index.js';
import { loadConfig, type ConfigLoadOptions, type ResolvedConfig } from '#platform/index.js';
/** The composition root (ENTERPRISE-EXT-1), the one owner of the process-wide registry lifecycle: until the first composed entry runs, an
 * extension registers target adapters and secret backends through the public `deckent/extensions` entry; `composeCore` then registers the
 * configuration sections and seals adapter, secret and MCP capability registries, so a validated configuration never changes meaning (a late registration is the typed
 * `RegistryError('REGISTRY_SEALED')`). Registration grants no authority: policy decides every operation, configuration selects every backend. */
export function composeCore(): void { registerProviderConfig(); mcpCapabilityRegistry.seal(); }
/** Every composed configuration read goes through the root, so the sections it validates against are always complete. */
export function loadComposedConfig(projectRoot: string, options: ConfigLoadOptions = {}): Promise<ResolvedConfig> { composeCore(); return loadConfig(projectRoot, options); }
