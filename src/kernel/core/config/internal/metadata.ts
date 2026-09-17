import { CORE_SCHEMA, configSections } from './schema.js';
import { createDefaultConfig } from './defaults.js';
export function getConfigMetadata(): readonly { key: string; owner: string; defaultValue: unknown }[] {
  const defaults = createDefaultConfig();
  return [...Object.keys(CORE_SCHEMA.shape).map(key => ({ key, owner: 'kernel', defaultValue: defaults[key] })),
    ...[...configSections().keys()].map(key => ({ key, owner: key, defaultValue: defaults[key] ?? null }))];
}
