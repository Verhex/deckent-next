import type { Locale, Params } from '#platform/core/i18n/index.js';

export type ErrorCategory = 'error' | 'usage' | 'config';

/** Machine identity and localized presentation are separate from exit policy. */
export class DeckentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly suggestion?: string,
    public readonly docLink?: string,
    public readonly whatHappened?: string,
    public readonly why?: string,
    public readonly howToFix?: readonly string[],
    public readonly category: ErrorCategory = 'error',
    options?: ErrorOptions,
    public readonly localize?: (locale: Locale) => { message: string; suggestion?: string; whatHappened?: string; why?: string; howToFix?: readonly string[] },
    public readonly params?: Params,
  ) {
    super(message, options);
    this.name = 'DeckentError';
  }
}
