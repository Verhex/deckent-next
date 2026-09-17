import { DeckentError } from '#platform/core/errors/index.js';
import { t, resolveLocale, type Locale } from '#platform/core/i18n/index.js';
export interface ConfigIssue { readonly path: string; readonly reason: string }
export interface ConfigWarning { readonly code: string; readonly path: string; readonly message: string }
export class ConfigValidationError extends DeckentError {
  constructor(public readonly issues: readonly ConfigIssue[], locale: Locale = resolveLocale()) {
    const localize = (target: Locale) => ({ message: t('error.CONFIG_VALIDATION', { issues: issues.map(i => t('config.valueInvalid', { path: i.path, reason: i.reason }, target)).join('; ') }, target) });
    super('CONFIG_VALIDATION', localize(locale).message, undefined, undefined, undefined, undefined, undefined, 'config', undefined, localize);
    this.name = 'ConfigValidationError';
  }
}
