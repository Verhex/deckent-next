import { messageText, type Locale } from '#platform/index.js';
import type { ProviderConnectHost, ProviderConnectKindView } from './context.js';
import presentation from './presentation.json' with { type: 'json' };

export function providerKindLabel(kind: ProviderConnectKindView, locale: Locale): string {
  const key = (presentation.subscriptionLabelKeys as Readonly<Record<string, string>>)[kind.labelKey];
  return (kind.headlessLogin && key ? messageText(key, locale) : undefined) ?? messageText(kind.labelKey, locale) ?? kind.id;
}

/** Registry-backed seed identity, also for a channel discovered at an address (`<kind>-<32 hex>`, adapters `providerDiscoveryChannel`; FIX9: never the hash); unknown/custom providers keep their text. */
export function providerDisplayName(id: string, host: ProviderConnectHost | undefined, locale: Locale): string {
  const kindId = /^(.+)-[0-9a-f]{32}$/u.exec(id)?.[1], kind = host?.kinds.find(kind => kind.catalogProviderId === id || kind.id === id || kind.id === kindId);
  return kind ? providerKindLabel(kind, locale) : id;
}
