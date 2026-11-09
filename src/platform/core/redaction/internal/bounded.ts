import REDACTION_TABLE from './patterns.json' with { type: 'json' };
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
type DiagnosticRow = Readonly<{ pattern: RegExp; replacement: string; parts: readonly DiagnosticRow[] }>;
const diagnosticRow = (row: { source: string; flags: string; replacement?: string; parts?: readonly { source: string; flags: string; replacement: string }[] }): DiagnosticRow =>
  Object.freeze({ pattern: new RegExp(row.source, row.flags), replacement: row.replacement ?? '', parts: (row.parts ?? []).map(diagnosticRow) });
const DIAGNOSTIC_ROWS = REDACTION_TABLE.diagnosticPatterns.map(diagnosticRow);
/** KG8 P14: the diagnostic profile of the canonical table (private invocation diagnostics only), stricter than the record rows: any Basic/Bearer
 * value, private key blocks, quoted key-value values, URL userinfo and query, e-mail addresses and 24+ character runs. Applied after the record
 * producer, in table order; a row with `parts` rewrites each match with its parts in order. The S6 gate does not read these rows. */
export function redactForDiagnostic(text: string, known: KnownSecretSnapshot = EMPTY_KNOWN_SECRETS): string {
  return DIAGNOSTIC_ROWS.reduce((out, row) => row.parts.length ? out.replace(row.pattern, match => row.parts.reduce((value, part) => value.replace(part.pattern, part.replacement), match))
    : out.replace(row.pattern, row.replacement), redactForRecord(text, known));
}
