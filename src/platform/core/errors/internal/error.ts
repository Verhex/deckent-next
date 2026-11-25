import { CodedError } from './coded-error.js';
import type { Locale, Params } from '#platform/core/i18n/index.js';

export type ErrorCategory = 'error' | 'usage' | 'config';

/** Extra lines for human fatal output. The primary error owns the exit, JSON and crash handling. */
export class FatalErrorWithDetails extends Error {
  constructor(readonly primary: unknown, readonly lines: readonly string[]) { super(); }
}

/** Machine identity and localized presentation are separate from exit policy. */
export class DeckentError extends CodedError {
  constructor(
    public override readonly code: string,
    message: string,
    public readonly suggestion?: string,
    public readonly docLink?: string,
    public readonly whatHappened?: string,
    public readonly why?: string,
    public readonly howToFix?: readonly string[],
    public readonly category: ErrorCategory = 'error',
    options?: ErrorOptions,
    public readonly localize?: (locale: Locale) => { message: string; suggestion?: string; whatHappened?: string; why?: string; howToFix?: readonly string[] },
    public override readonly params?: Params,
  ) {
    super(code, { message, ...options });
    this.name = 'DeckentError';
  }
}
