import en from './en.json' with { type: 'json' };
import tr from './tr.json' with { type: 'json' };

export type Locale = 'en' | 'tr';
export type MessageKey = keyof typeof en;
type Params = Readonly<Record<string, string | number>>;

const catalogs: Readonly<Record<Locale, Readonly<Record<string, string>>>> = { en, tr };
const SUPPORTED: readonly Locale[] = ['en', 'tr'];

/** Resolve the active locale from explicit choice, then DECKENT_LANG, then LANG; English is the default. */
export function resolveLocale(explicit?: string, env: NodeJS.ProcessEnv = process.env): Locale {
  for (const candidate of [explicit, env['DECKENT_LANG'], env['LANG']]) {
    const short = candidate?.slice(0, 2).toLowerCase();
    if (short && (SUPPORTED as readonly string[]).includes(short)) return short as Locale;
  }
  return 'en';
}

/** Translate a catalog key; `{name}` placeholders are replaced from params. Keys must be string literals (lint-arch). */
export function t(key: MessageKey, params: Params = {}, locale: Locale = resolveLocale()): string {
  const template = catalogs[locale][key] ?? catalogs.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}
