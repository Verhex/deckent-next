import { configSections } from './schema.js';
import { CONFIG_FIELDS } from '#kernel/core/config-fields/index.js';
import { createDefaultConfig } from './defaults.js';
export interface ConfigMetadata {
  readonly key: string; readonly owner: string; readonly defaultValue: unknown;
  readonly descriptionKey: string; readonly tier: string; readonly since: string;
}
export function getConfigMetadata(): readonly ConfigMetadata[] {
  const defaults = createDefaultConfig();
  return [...Object.entries(CONFIG_FIELDS).map(([key, field]) => ({ key, owner: 'kernel', defaultValue: defaults[key], ...field.metadata })),
    ...[...configSections()].map(([key, section]) => ({ key, owner: key, defaultValue: defaults[key] ?? null,
      ...(section.options.metadata ?? { ...CONFIG_FIELDS.schema_version.metadata, descriptionKey: 'config.section' }) }))];
}
