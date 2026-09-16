import type { DeckentConfig } from '../../../core/config/index.js';
import { configSections } from '../../../core/config/index.js';

/** New deep copy per request; absent provider selection remains explicit null until P1. */
export function createDefaultConfig(): DeckentConfig {
  const defaults: DeckentConfig = {
    schema_version: 2, language: 'en', mode: 'performance', output_mode: 'standard',
    projectName: 'deckent-project', max_workers: 'auto', enforce_principal_assurance: false,
    strict_tenant_isolation: false, tenant_id: 'local', deckent_style: 'sprint',
    auth_mode: 'subscription', routing_engine: 'v3', spawn_backend: 'auto',
    live_trace: { enabled: false }, providers: { brain: null, worker: null, fallback: null, overrides: {} },
  };
  for (const [name, { schema }] of configSections()) {
    const parsed = schema.safeParse({});
    if (parsed.success) defaults[name] = structuredClone(parsed.data);
  }
  return defaults;
}
