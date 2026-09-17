import { CORE_SCHEMA, configSections, type DeckentConfig } from './schema.js';

/** New deep copy per request; absent provider selection remains explicit null until P1. */
export function createDefaultConfig(): DeckentConfig {
  const defaults: DeckentConfig = CORE_SCHEMA.parse({});
  for (const [name, { schema }] of configSections()) {
    const parsed = schema.safeParse({});
    if (parsed.success) defaults[name] = structuredClone(parsed.data);
  }
  return defaults;
}
