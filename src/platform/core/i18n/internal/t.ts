import { messageText } from './registry.js';
import { resolveLocale } from './resolve-locale.js';
import type { Locale, Params } from './types.js';
import type { MessageKey } from './families.js';

/** Pure lookup/interpolation; unknown runtime keys stay visible and unsupported locales fall back to English. */
export function t(key: MessageKey, params: Params = {}, locale: Locale = resolveLocale()): string {
  return messageText(key, locale, params) ?? key;
}
