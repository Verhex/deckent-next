import { NODE_ENGINE_RANGE } from '#kernel/core/common/index.js';
import { families } from './families.js';
import identicalMessages from './identical-messages.json' with { type: 'json' };
import { LOCALES, type Catalog, type MessageFamily, type MessageRegistry, type Params } from './types.js';

const placeholders = (value: string) => [...new Set([...value.matchAll(/\{(\w+)\}/g)].map(m => m[1]))].sort().join(',');
/** The same constructor validates production catalogs and extension catalogs. No mutation authority escapes. */
export function createMessageRegistry(input: readonly MessageFamily[], defaults: Readonly<Record<string, Params>> = {}, identical: readonly string[] = []): MessageRegistry {
  const catalogs: Record<string, Record<string, string>> = { en: Object.create(null) as Record<string, string>, tr: Object.create(null) as Record<string, string> };
  const allowed = new Set(identical);
  for (const family of input) {
    const keys = Object.keys(family.en).sort();
    if (keys.join('\0') !== Object.keys(family.tr).sort().join('\0')) throw new Error('I18N_KEY_PARITY');
    for (const key of keys) {
      if (placeholders(family.en[key]!) !== placeholders(family.tr[key]!)) throw new Error(`I18N_PLACEHOLDER_PARITY:${key}`);
      if (family.en[key] === family.tr[key] && !allowed.has(key)) throw new Error(`I18N_TRANSLATION_REQUIRED:${key}`);
      for (const locale of LOCALES) {
        if (Object.hasOwn(catalogs[locale]!, key)) throw new Error(`I18N_DUPLICATE:${key}`);
        const value = family[locale][key]!;
        if (!value.trim() || value.includes('\u001b')) throw new Error(`I18N_INVALID_VALUE:${key}`);
        catalogs[locale]![key] = value;
      }
    }
  }
  const parameters = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, Object.freeze({ ...value })]));
  return Object.freeze({ catalogs: Object.freeze({ en: Object.freeze(catalogs['en']!) as Catalog, tr: Object.freeze(catalogs['tr']!) as Catalog }),
    keys: Object.freeze(Object.keys(catalogs['en']!).sort()), defaultParams: Object.freeze(parameters) });
}
export const MESSAGE_REGISTRY = createMessageRegistry(families, {
  'error.node_version_low': { floor: NODE_ENGINE_RANGE },
  'desktop.error.node_not_found': { floor: NODE_ENGINE_RANGE },
}, [...identicalMessages, 'cli.version']); // Existing K0 machine identity format is intentionally identical.
export const MESSAGE_KEYS = MESSAGE_REGISTRY.keys;
