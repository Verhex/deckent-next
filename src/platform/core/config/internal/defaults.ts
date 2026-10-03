import { CORE_SCHEMA, configSections, type DeckentConfig } from './schema.js';
import { deepMerge, type JsonRecord } from '#platform/core/utils/index.js';

/** New deep copy per request; absent provider selection remains explicit null until P1. */
export function createDefaultConfig(): DeckentConfig {
  const defaults: DeckentConfig = CORE_SCHEMA.parse({});
  for (const [name, { schema }] of configSections()) {
    const parsed = schema.safeParse({});
    if (parsed.success) defaults[name] = structuredClone(parsed.data);
  }
  return defaults;
}

/** Preserve derived-default absence until validation sees the effective service capacity. */
export function mergeConfigLayers(global: JsonRecord, project: JsonRecord): DeckentConfig {
  const defaults = createDefaultConfig();
  delete (defaults.runRuntime as Partial<DeckentConfig['runRuntime']>).maxConcurrentRuns;
  return deepMerge(deepMerge(defaults, global), project);
}
