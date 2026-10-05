import REDACTION_TABLE from './patterns.json' with { type: 'json' };

export interface NamedKnownSecret { readonly name: string | null; readonly value: string }
export interface RedactionMatch { readonly kind: string; readonly count: number }
export interface RedactionResult { readonly text: string; readonly knownMatches: number; readonly patternMatches: readonly RedactionMatch[] }
/** Opaque, per-operation snapshot of values already resolved by an authorized producer. JSON never exposes the values. */
export interface KnownSecretSpan { readonly start: number; readonly end: number; readonly label: string }
export interface KnownSecretSnapshot {
  readonly spans: (text: string) => readonly KnownSecretSpan[];
  /** Record attribution only; raw known values take priority over this snapshot's own label lookalikes. */
  readonly recordSpans: (text: string) => readonly KnownSecretSpan[];
  readonly apply: (text: string, redactRest: (text: string) => string) => { readonly text: string; readonly matches: number };
}
const label = (name: string | null) => name === null ? REDACTION_TABLE.knownLabel.anonymous : REDACTION_TABLE.knownLabel.prefix + name + REDACTION_TABLE.knownLabel.suffix;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Every exact UTF-16 start is covered; longest value wins at the same start, duplicate values use the first canonical name. */
export function snapshotKnownSecrets(input: readonly NamedKnownSecret[]): KnownSecretSnapshot {
  if (input.some(entry => entry.name !== null && !/^[A-Z_][A-Z0-9_]{0,127}$/.test(entry.name))) throw new Error('REDACTION_KNOWN_NAME_INVALID');
  const entries = input.filter(entry => entry.value.length >= 6)
    .map(entry => ({ ...entry })).sort((a, b) => b.value.length - a.value.length || ((a.name ?? '') < (b.name ?? '') ? -1 : (a.name ?? '') > (b.name ?? '') ? 1 : 0));
  const names = new Map<string, string | null>();
  for (const entry of entries) if (!names.has(entry.value)) names.set(entry.value, entry.name);
  const source = [...names.keys()].map(escape).join('|');
  const spans = (text: string): readonly KnownSecretSpan[] => Object.freeze(source ? [...text.matchAll(new RegExp(`(?=(${source}))`, 'g'))]
    .map(match => Object.freeze({ start: match.index, end: match.index + match[1]!.length, label: label(names.get(match[1]!) ?? null) })) : []);
  const recordSource = [...new Set([...names.values()].filter(name => name !== null).map(label))].map(escape).join('|');
  const recordSpans = (text: string): readonly KnownSecretSpan[] => {
    const raw = spans(text), records: KnownSecretSpan[] = [];
    let rawIndex = 0, rawEnd = 0;
    if (recordSource) for (const match of text.matchAll(new RegExp(`(?=(${recordSource}))`, 'g'))) {
      const start = match.index, end = start + match[1]!.length;
      while (rawIndex < raw.length && raw[rawIndex]!.start < end) { rawEnd = Math.max(rawEnd, raw[rawIndex]!.end); rawIndex++; }
      // A literal label containing an actual registered value is still raw secret text, never a masking exemption.
      if (rawEnd <= start) records.push(Object.freeze({ start, end, label: match[1]! }));
    }
    return Object.freeze([...raw, ...records]);
  };
  return Object.freeze({ spans, recordSpans, apply(text: string, redactRest: (text: string) => string) {
    const matches = spans(text), merged: { start: number; end: number; labels: string[] }[] = [];
    for (const match of matches) {
      const previous = merged.at(-1);
      if (previous && match.start < previous.end) { previous.end = Math.max(previous.end, match.end); previous.labels.push(match.label); }
      else merged.push({ start: match.start, end: match.end, labels: [match.label] });
    }
    let cursor = 0, out = '';
    for (const match of merged) {
      out += redactRest(text.slice(cursor, match.start)) + [...new Set(match.labels)].join('');
      cursor = match.end;
    }
    return { text: out + redactRest(text.slice(cursor)), matches: matches.length };
  } });
}
export const EMPTY_KNOWN_SECRETS = snapshotKnownSecrets([]);
/** One canonical versioned table; the standalone worker mirror is generated from this table and implementation. */
export const REDACTION_PATTERNS = Object.freeze(REDACTION_TABLE.patterns.map(row => Object.freeze({ ...row })));
const patterns = (text: string) => Object.freeze(REDACTION_PATTERNS.map(row => ({ kind: row.id, count: [...text.matchAll(new RegExp(row.source, row.flags))].length })).filter(row => row.count > 0).map(row => Object.freeze(row)));
/** Derived record text only: recordSource preserves legacy record coverage; counters/standing use source.
 * Merge original-text coverage before replacing. This snapshot's generated labels retain attribution without
 * exempting any pattern coverage or raw known value, including literal marker lookalikes. */
export function redactForRecord(text: string, known: KnownSecretSnapshot = EMPTY_KNOWN_SECRETS): string {
  const spans: { start: number; end: number; labels: string[] }[] = known.recordSpans(text).map(match => ({ start: match.start, end: match.end, labels: [match.label] }));
  for (const row of REDACTION_PATTERNS) for (const match of text.matchAll(new RegExp(row.recordSource ?? row.source, row.flags))) {
    const prefix = row.replacement.startsWith('$1') ? match[1]!.length : 0, suffix = row.replacement.endsWith('$2') ? match[2]!.length : 0;
    spans.push({ start: match.index + prefix, end: match.index + match[0].length - suffix, labels: [] });
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: typeof spans = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span.start < previous.end) { previous.end = Math.max(previous.end, span.end); previous.labels.push(...span.labels); }
    else merged.push({ ...span, labels: [...span.labels] });
  }
  let cursor = 0, out = '';
  for (const span of merged) {
    out += text.slice(cursor, span.start) + (span.labels.length ? [...new Set(span.labels)].join('') : REDACTION_TABLE.knownLabel.anonymous);
    cursor = span.end;
  }
  return out + text.slice(cursor);
}
/** Unknown credential-shaped text stays byte-for-byte visible in decision mode; counts contain no values. */
export function redactForDecision(text: string, known: KnownSecretSnapshot = EMPTY_KNOWN_SECRETS): RedactionResult {
  const result = known.apply(text, part => part);
  return Object.freeze({ text: result.text, knownMatches: result.matches, patternMatches: patterns(text) });
}
export function hasSecret(text: string, known: KnownSecretSnapshot = EMPTY_KNOWN_SECRETS): boolean {
  return known.apply(text, part => part).matches > 0 || REDACTION_PATTERNS.some(row => new RegExp(row.source, row.flags).test(text));
}
