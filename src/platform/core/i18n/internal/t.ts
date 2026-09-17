import { MESSAGE_REGISTRY } from './registry.js';
import { resolveLocale } from './resolve-locale.js';
import type { Locale, Params } from './types.js';
import type { MessageKey } from './families.js';

/** Pure lookup/interpolation; unknown runtime keys stay visible and unsupported locales fall back to English. */
export function t(key: MessageKey, params: Params = {}, locale: Locale = resolveLocale()): string {
  const catalog = MESSAGE_REGISTRY.catalogs[locale === 'tr' ? 'tr' : 'en'];
  if (!Object.hasOwn(catalog, key)) return key;
  const effective = { ...MESSAGE_REGISTRY.defaultParams[key], ...params };
  return catalog[key]!.replace(/\{(\w+)\}/g, (_, name: string) => Object.hasOwn(effective, name) ? String(effective[name] ?? `{${name}}`) : `{${name}}`);
}
