import { MESSAGE_REGISTRY, type Locale } from '#platform/index.js';
import type { ProviderConnectHost } from './context.js';

/** Registry-backed seed identity; unknown/custom catalog providers keep their exact text. */
export function providerDisplayName(id: string, host: ProviderConnectHost | undefined, locale: Locale): string {
  const kind = host?.kinds.find(kind => kind.catalogProviderId === id || kind.id === id);
  return kind ? (MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>)[kind.labelKey] ?? id : id;
}
