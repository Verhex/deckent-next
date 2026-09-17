export type Locale = 'en' | 'tr';
export type Params = Readonly<Record<string, string | number>>;
export const LOCALES = Object.freeze(['en', 'tr'] as const);
export const SUPPORTED_LANGUAGES: readonly Locale[] = LOCALES;
export type Catalog = Readonly<Record<string, string>>;
export type MessageFamily = Readonly<Record<Locale, Catalog>>;
export interface MessageRegistry {
  readonly catalogs: Readonly<Record<Locale, Catalog>>;
  readonly keys: readonly string[];
  readonly defaultParams: Readonly<Record<string, Params>>;
}
