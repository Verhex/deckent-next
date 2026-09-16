import en from './en.json' with { type: 'json' };
import tr from './tr.json' with { type: 'json' };

export type Locale = 'en' | 'tr';
export type MessageKey = keyof typeof en;
export type Params = Readonly<Record<string, string | number>>;

const catalogs: Readonly<Record<Locale, Readonly<Record<string, string>>>> = { en, tr };
export const SUPPORTED_LANGUAGES: readonly Locale[] = ['en', 'tr'];

/** Call-time locale precedence: explicit → product env → config → system env → English. */
export function resolveLocale(explicit?: string, env: NodeJS.ProcessEnv = process.env, configLanguage?: string): Locale {
  for (const candidate of [explicit, env['DECKENT_LANGUAGE'], env['DECKENT_LANG'], configLanguage, env['LC_ALL'], env['LANG']]) {
    const short = candidate?.slice(0, 2).toLowerCase();
    if (short && (SUPPORTED_LANGUAGES as readonly string[]).includes(short)) return short as Locale;
  }
  return 'en';
}

/** Translate a catalog key; `{name}` placeholders are replaced from params. Keys must be string literals (lint-arch). */
export function t(key: MessageKey, params: Params = {}, locale: Locale = resolveLocale()): string {
  const template = catalogs[locale][key] ?? catalogs.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}
