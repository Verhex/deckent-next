/**
 * Model-bound text is well-formed UTF-16 (SURROGATE-CUT 2026-09-30). A cut by code units can split a surrogate pair (an emoji);
 * JSON then carries the lone half as `\ud83d` and a provider tokenizer rejects the whole request (HTTP 400), so a persisted cut
 * (a compaction summary) would reject every later round. Every bounding of text that reaches a model cuts at a code point
 * boundary, and the provider request boundary replaces any lone surrogate that is still present with U+FFFD.
 */
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;
// Code-unit mode (no `u` flag), so the halves of a pair are seen; the probe has no `g` flag, so it keeps no `lastIndex` state.
const LONE_SURROGATE_PROBE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATES = new RegExp(LONE_SURROGATE_PROBE.source, 'g');

/** `index` moved back by one when it falls inside a surrogate pair, so neither side of a cut there holds half a pair. */
export function modelTextBoundary(text: string, index: number): number {
  const at = Math.max(0, Math.min(Math.floor(index), text.length));
  return at > 0 && at < text.length && isHigh(text.charCodeAt(at - 1)) && isLow(text.charCodeAt(at)) ? at - 1 : at;
}

/** The longest prefix of at most `maxCodeUnits` UTF-16 code units that ends on a code point boundary. */
export function modelTextPrefix(text: string, maxCodeUnits: number): string {
  return text.length <= maxCodeUnits ? text : text.slice(0, modelTextBoundary(text, maxCodeUnits));
}

/** `text` with every lone surrogate replaced by U+FFFD (what a UTF-8 encoder writes for it); well-formed text is returned as is. */
export function wellFormedModelText(text: string): string {
  return LONE_SURROGATE_PROBE.test(text) ? text.replace(LONE_SURROGATES, '\uFFFD') : text;
}

/** A JSON value with every string (object keys included) made well-formed; the same value when nothing needed a change. */
export function wellFormedModelJson<T>(value: T): T {
  if (typeof value === 'string') return wellFormedModelText(value) as T;
  if (Array.isArray(value)) {
    const mapped = value.map(item => wellFormedModelJson(item) as unknown);
    return mapped.every((item, index) => item === value[index]) ? value : mapped as T;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => [wellFormedModelText(key), wellFormedModelJson(item)] as const);
    const same = entries.every(([key, item]) => Object.hasOwn(value, key) && (value as Record<string, unknown>)[key] === item);
    return same ? value : Object.fromEntries(entries) as T;
  }
  return value;
}
