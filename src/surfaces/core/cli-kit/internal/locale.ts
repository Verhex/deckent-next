import { LOCALES, envValue, resolveLocale, type Locale } from '#platform/index.js';

const supported = (value: string | undefined): value is string => !!value && (LOCALES as readonly string[]).includes(value.slice(0, 2).toLowerCase());

/**
 * The CLI locale chain (L-KIT, INIT-D6): `--lang` > DECKENT_LANGUAGE/DECKENT_LANG > config `language` > LC_ALL > LC_MESSAGES > LANG > en.
 * An empty variable counts as unset; an unsupported value is passed over. It wraps the platform chain (one precedence owner) and only adds
 * LC_MESSAGES: the first supported system value (LC_ALL, LC_MESSAGES, LANG in POSIX order) fills the platform's system slot.
 */
export function resolveCliLocale(input: { readonly flag?: string | undefined; readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly configLanguage?: string | undefined } = {}): Locale {
  const env = input.env ?? process.env;
  const system = [envValue(env, 'LC_ALL'), envValue(env, 'LC_MESSAGES'), envValue(env, 'LANG')].find(supported);
  return resolveLocale(input.flag || undefined, { DECKENT_LANGUAGE: envValue(env, 'DECKENT_LANGUAGE'), DECKENT_LANG: envValue(env, 'DECKENT_LANG'),
    ...(system ? { LC_ALL: system } : {}) }, input.configLanguage || undefined);
}

/**
 * The locale a command renders in: its own parsed `--lang` when supported, else the one the host resolved once for this call
 * (`context.locale`, config language included), else the environment chain. Reports the choice through `onLocale`, so a later fatal
 * error renders in the same language.
 */
export function commandLocale(context: { readonly locale?: Locale; readonly env?: NodeJS.ProcessEnv; readonly onLocale?: (locale: Locale) => void },
  flag?: string): Locale {
  const locale = supported(flag) ? resolveCliLocale({ flag, env: context.env }) : context.locale ?? resolveCliLocale({ env: context.env });
  context.onLocale?.(locale);
  return locale;
}
