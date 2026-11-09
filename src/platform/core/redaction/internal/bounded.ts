import { EMPTY_KNOWN_SECRETS, redactForRecord, snapshotKnownSecrets, type KnownSecretSnapshot } from './redact.js';

/** Unnamed values (an MCP server's resolved launch values) as one snapshot; each is masked with the anonymous label. */
export const knownSecretValues = (values: readonly string[]): KnownSecretSnapshot => snapshotKnownSecrets(values.map(value => ({ name: null, value })));
/** One snapshot that covers every given one (KG8 P13: the single combiner). */
export function combineKnownSecrets(...snapshots: readonly KnownSecretSnapshot[]): KnownSecretSnapshot {
  return snapshots.reduce((a, b) => Object.freeze({
    spans: (text: string) => [...a.spans(text), ...b.spans(text)], recordSpans: (text: string) => [...a.recordSpans(text), ...b.recordSpans(text)],
    pendingStart: (text: string) => Math.min(a.pendingStart(text), b.pendingStart(text)),
    apply: (text: string, rest: (text: string) => string) => {
      let matches = 0;
      const result = a.apply(text, part => { const nested = b.apply(part, rest); matches += nested.matches; return nested.text; });
      return { ...result, matches: result.matches + matches };
    },
  }), EMPTY_KNOWN_SECRETS);
}
/** Display text outside the worker mirror (KG8 P9): the record producer, control characters as spaces, at most `max` UTF-16 units — the
 * semantics of the worker's `redactText`, pinned equal by `redaction-parity.test.ts`. */
export function redactBounded(text: string, known: KnownSecretSnapshot = EMPTY_KNOWN_SECRETS, max = Number.MAX_SAFE_INTEGER): string {
  // eslint-disable-next-line no-control-regex
  const out = redactForRecord(text, known).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
  return out.length > max ? out.slice(0, max - 1) + '…' : out;
}
