import { DeckentError, ErrorRegistry } from '#platform/core/errors/index.js';
import { t, resolveLocale, type Locale } from '#platform/core/i18n/index.js';
export interface ConfigIssue { readonly path: string; readonly reason: string }
export interface ConfigWarning { readonly code: string; readonly path: string; readonly message: string }
/** A reason that is a registered error code renders as `CODE: <localized sentence>`; any other reason (schema issue names) stays literal. */
const issueReason = (reason: string, locale: Locale): string => { const entry = ErrorRegistry.get(reason, locale); return entry ? `${reason}: ${entry.message}` : reason; };
export class ConfigValidationError extends DeckentError {
  constructor(public readonly issues: readonly ConfigIssue[], locale: Locale = resolveLocale()) {
    const localize = (target: Locale) => ({ message: t('error.CONFIG_VALIDATION', { issues: issues.map(i => t('config.valueInvalid', { path: i.path, reason: issueReason(i.reason, target) }, target)).join('; ') }, target) });
    super('CONFIG_VALIDATION', localize(locale).message, undefined, undefined, undefined, undefined, undefined, 'config', undefined, localize);
    this.name = 'ConfigValidationError';
  }
}
