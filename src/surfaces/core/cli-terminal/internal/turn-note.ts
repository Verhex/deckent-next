import { ErrorRegistry, t, type Locale } from '#platform/index.js';
import type { TurnDelta } from '#surfaces/core/terminal/index.js';

/** Human projection only: the service's original diagnostic note and typed invocation receipt remain unchanged. */
export async function* humanTurnNotes(source: AsyncIterable<TurnDelta>, locale: Locale): AsyncIterable<TurnDelta> {
  for await (const delta of source) {
    if (delta.kind !== 'done' || !delta.note) { yield delta; continue; }
    const note = delta.note.replace(/^\[deckent\]\s+[A-Z][A-Z0-9_]+:\s*/u, '')
      .replace(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/gu, code => {
        if (!ErrorRegistry.has(code)) return code;
        const message = ErrorRegistry.get(code, locale)?.message;
        return message && !/\{[^}]+\}/u.test(message) ? message : t('terminal.chat.failed', {}, locale);
      });
    yield { ...delta, note };
  }
}
