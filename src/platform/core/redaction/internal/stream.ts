import REDACTION_TABLE from './patterns.json' with { type: 'json' };
import { EMPTY_KNOWN_SECRETS, REDACTION_PATTERNS, redactForRecord, type KnownSecretSnapshot } from './redact.js';

/** Security invariant, UTF-16 units: unresolved text cannot grow without bound. Overflow withholds the rest of this field. */
export const RECORD_STREAM_LOOKBACK = 4_096;
export type RecordStreamState = Readonly<{ held: string; withheld: boolean }>;
export const EMPTY_RECORD_STREAM: RecordStreamState = Object.freeze({ held: '', withheld: false });
const MASK = REDACTION_TABLE.knownLabel.anonymous;
const identity = (text: string) => text;
/** Only a whitespace-terminated atom can be committed: credential patterns may extend a token on the next delta.
 * Bearer and assignment headers may cross whitespace/newlines. These potential starts are part of the canonical table. */
function pendingStart(text: string, known: KnownSecretSnapshot): number {
  let cut = Math.min(known.pendingStart(text), text.search(/\S*$/u));
  for (const row of REDACTION_PATTERNS) if ('streamSource' in row && typeof row.streamSource === 'string') {
    for (const match of text.matchAll(new RegExp(row.streamSource, row.flags))) cut = Math.min(cut, match.index);
  }
  // Keep pattern context (e.g. Bearer + whitespace) with a still-open value; detaching it would bypass the next match.
  const spans = [...known.recordSpans(text)];
  for (const row of REDACTION_PATTERNS) for (const match of text.matchAll(new RegExp(row.recordSource ?? row.source, row.flags))) {
    spans.push({ start: match.index, end: match.index + match[0].length, label: '' });
  }
  for (const span of spans.sort((a, b) => b.start - a.start)) if (span.start < cut && span.end > cut) cut = span.start;
  return cut;
}
/** Pure feed; callers retain state per field/call. Only committed text may enter irreversible sinks or display cuts.
 * `prepare` is the display's existing control projection. A changed raw buffer commits only at a surface-supplied stable boundary, so split escapes cannot reconstruct
 * a secret across commits. Raw storage/history and DECISION projection do not use this record-only adapter. */
export function feedRecordStream(state: RecordStreamState, chunk: string, known: KnownSecretSnapshot = EMPTY_KNOWN_SECRETS,
  prepare: (text: string) => string = identity, stableEnd?: (text: string) => number): Readonly<{ state: RecordStreamState; text: string }> {
  if (state.withheld) return { state, text: '' };
  let held = state.held, out = '';
  for (let offset = 0; offset < chunk.length; offset += RECORD_STREAM_LOOKBACK) {
    const buffer = held + chunk.slice(offset, offset + RECORD_STREAM_LOOKBACK), prepared = prepare(buffer);
    const projectedCut = pendingStart(prepared, known);
    let cut = prepared === buffer ? projectedCut : 0, committed = prepared.slice(0, cut);
    if (prepared !== buffer && stableEnd) {
      const end = stableEnd(buffer), prefix = prepare(buffer.slice(0, end));
      // The surface supplies a stable raw boundary (e.g. a surviving newline outside any open escape).
      // It cannot cross a known prefix or detach the context of an open pattern in the projected text.
      if (end <= pendingStart(buffer, known) && prefix.length <= projectedCut && prefix + prepare(buffer.slice(end)) === prepared) {
        cut = end; committed = prepare(redactForRecord(buffer.slice(0, end), known));
      }
    }
    out += redactForRecord(committed, known);
    held = buffer.slice(cut);
    if (held.length > RECORD_STREAM_LOOKBACK) return { state: Object.freeze({ held: '', withheld: true }), text: out + MASK };
  }
  return { state: Object.freeze({ held, withheld: false }), text: out };
}
/** A live preview never exposes a suffix that could still become a known secret. It is never committed to history. */
export function previewRecordStream(state: RecordStreamState, known: KnownSecretSnapshot = EMPTY_KNOWN_SECRETS,
  prepare: (text: string) => string = identity): string {
  if (state.withheld) return '';
  // Protect original known bytes before control/CRLF normalization, then protect values reconstructed by that projection.
  const protect = (text: string) => {
    let cut = known.pendingStart(text);
    const spans = known.recordSpans(text);
    if (spans.some(span => span.start <= cut && span.end >= text.replace(/(?:\r?\n)+$/g, '').length)) cut = text.length;
    for (const span of [...spans].sort((a, b) => b.start - a.start)) if (span.start < cut && span.end > cut) cut = span.start;
    return redactForRecord(text.slice(0, cut), known) + (cut < text.length ? MASK : '');
  };
  let out = protect(prepare(protect(state.held)));
  for (const row of REDACTION_PATTERNS) if ('streamPreviewSource' in row && typeof row.streamPreviewSource === 'string') {
    out = out.replace(new RegExp(row.streamPreviewSource, row.flags), row.replacement);
  }
  return out;
}
/** A field end (including cancellation) masks incomplete known prefixes rather than exposing a credential fragment. */
export function finishRecordStream(state: RecordStreamState, known: KnownSecretSnapshot = EMPTY_KNOWN_SECRETS,
  prepare: (text: string) => string = identity): string {
  return previewRecordStream(state, known, prepare);
}
