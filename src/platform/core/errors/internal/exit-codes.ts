import { DeckentError } from './error.js';
export const EXIT_CODES = Object.freeze({ success: 0, error: 1, usage: 2, config: 78 } as const);
export type ExitCode = typeof EXIT_CODES[keyof typeof EXIT_CODES];
export function exitCodeFor(error?: unknown): ExitCode {
  return error === undefined ? EXIT_CODES.success
    : error instanceof DeckentError ? EXIT_CODES[error.category] : EXIT_CODES.error;
}
