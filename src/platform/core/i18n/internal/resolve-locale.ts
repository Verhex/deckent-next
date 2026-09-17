import { LOCALES, type Locale } from './types.js';
/** Call-time locale precedence; no Node dependency when the caller supplies its environment. */
export function resolveLocale(explicit?: string, env: Readonly<Record<string, string | undefined>> = typeof process === 'undefined' ? {} : process.env, configLanguage?: string): Locale {
  for (const candidate of [explicit, env['DECKENT_LANGUAGE'], env['DECKENT_LANG'], configLanguage, env['LC_ALL'], env['LANG']]) {
    const short = candidate?.slice(0, 2).toLowerCase();
    if (short && (LOCALES as readonly string[]).includes(short)) return short as Locale;
  }
  return 'en';
}
