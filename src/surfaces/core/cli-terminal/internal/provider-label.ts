import { MESSAGE_REGISTRY, type Locale } from '#platform/index.js';
import type { ProviderConnectHost } from './context.js';

/** Registry-backed seed identity, also for a channel discovered at an address (`<kind>-<32 hex>`, adapters `providerDiscoveryChannel`; FIX9: never the hash); unknown/custom providers keep their text. */
export function providerDisplayName(id: string, host: ProviderConnectHost | undefined, locale: Locale): string {
  const kindId = /^(.+)-[0-9a-f]{32}$/u.exec(id)?.[1], kind = host?.kinds.find(kind => kind.catalogProviderId === id || kind.id === id || kind.id === kindId);
  return kind ? (MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>)[kind.labelKey] ?? id : id;
}
