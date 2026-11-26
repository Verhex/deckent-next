import { freezeConfigDefault } from '#platform/core/config-fields/index.js';
import { CORE_SCHEMA, configSections, configRegistryGeneration, type DeckentConfig } from './schema.js';
import { deepMerge, isRecord, type JsonRecord } from '#platform/core/utils/index.js';
import { validateStandardSchemaSync } from '#platform/core/validate/index.js';

let generation = -1, memo: DeckentConfig;
/** Independent deep copies; registry additions invalidate the private frozen defaults. */
export function createDefaultConfig(): DeckentConfig {
  const current = configRegistryGeneration();
  if (generation === current) return structuredClone(memo);
  const defaults: DeckentConfig = CORE_SCHEMA.parse({});
  for (const [name, { schema }] of configSections()) {
    const parsed = validateStandardSchemaSync(schema, {});
    if (parsed.status === 'valid') defaults[name] = structuredClone(parsed.value);
  }
  memo = freezeConfigDefault(structuredClone(defaults)); generation = current;
  return structuredClone(memo);
}

/** Preserve derived-default absence until validation sees the effective service capacity. */
export function mergeConfigLayers(global: JsonRecord, project: JsonRecord): DeckentConfig {
  const defaults = createDefaultConfig();
  delete (defaults.runRuntime as Partial<DeckentConfig['runRuntime']>).maxConcurrentRuns;
  // One setting controls every writer of an installation's shared package store.
  const installation = project['installation'];
  const overlay = isRecord(installation) ? { ...project, installation: { ...installation } } : project;
  if (overlay !== project) delete (overlay['installation'] as JsonRecord)['sealedPackageStoreMaxBytes'];
  const tools = global['toolchains'];
  const base = isRecord(tools) ? { ...global, toolchains: { ...tools } } : global;
  if (base !== global) delete (base['toolchains'] as JsonRecord)['packageAllowances'];
  return deepMerge(deepMerge(defaults, base), overlay);
}
