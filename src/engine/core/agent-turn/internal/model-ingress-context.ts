import { createHash } from 'node:crypto';

/** Versioned standard-data identity, not a customer allowlist or a legitimacy/risk policy. */
export const MODEL_INGRESS_UNICODE_IDENTITY = Object.freeze({
  schemaVersion: 1, ucdVersion: '17.0.0', emojiVersion: '17.0', cldrVersion: '48.2',
  cldrCommit: '11299982335beb974c1c63c45265184e759c0f41',
  dataSha256: 'c81b40d719cfbe73963c630d4044ad03731c9fe42983042c92a0aafced708cd0',
} as const);

type Range = readonly [number, number];
type EmojiProperty = 'Emoji' | 'Emoji_Presentation' | 'Emoji_Modifier' | 'Emoji_Modifier_Base';
type JoiningType = 'D' | 'L' | 'R' | 'T' | 'C';
export interface ModelIngressUnicodeData {
  readonly schemaVersion: 1;
  readonly ucdVersion: '17.0.0';
  readonly emojiVersion: '17.0';
  readonly cldrVersion: '48.2';
  readonly cldrCommit: typeof MODEL_INGRESS_UNICODE_IDENTITY.cldrCommit;
  readonly joiningTypeDefault: 'U';
  readonly emojiPropertyRanges: readonly (readonly [number, number, EmojiProperty])[];
  readonly emojiVariationSequences: readonly (readonly [number, number])[];
  readonly joiningTypeRanges: readonly (readonly [number, number, JoiningType])[];
  readonly viramaRanges: readonly Range[];
  readonly nonzeroCombiningClassRanges: readonly Range[];
  readonly letterRanges: readonly Range[];
  readonly nonspacingMarkRanges: readonly Range[];
  readonly dependentVowelRanges: readonly Range[];
  readonly validAlpha2FlagRegions: readonly string[];
  readonly validNumericTagRegions: readonly string[];
  readonly validTagSubdivisions: readonly string[];
  readonly scope: string;
}

declare const contextBrand: unique symbol;
/** Supplier-owned, deeply frozen facts for later pure-domain injection. No classifier/policy callback or raw text. */
export type ModelIngressUnicodeContext = {
  readonly identity: typeof MODEL_INGRESS_UNICODE_IDENTITY;
  readonly data: ModelIngressUnicodeData;
  readonly [contextBrand]: true;
};
export type ModelIngressContextResult =
  | { readonly status: 'ready'; readonly context: ModelIngressUnicodeContext }
  | { readonly status: 'unavailable'; readonly reason: 'missing-data' | 'invalid-input' | 'data-hash-mismatch' | 'invalid-data' };

const contexts = new WeakSet<object>();
const rangeKeys = ['viramaRanges', 'nonzeroCombiningClassRanges', 'letterRanges', 'nonspacingMarkRanges', 'dependentVowelRanges'] as const;
const scope = 'Minimum structural lookup proposal, not complete legitimate-natural-language classification; no LRM/RLM rule or contextual-policy allowlist embedded.';
const keys = ['schemaVersion', 'ucdVersion', 'emojiVersion', 'cldrVersion', 'cldrCommit', 'joiningTypeDefault', 'emojiPropertyRanges',
  'emojiVariationSequences', 'joiningTypeRanges', ...rangeKeys, 'validAlpha2FlagRegions', 'validNumericTagRegions', 'validTagSubdivisions', 'scope'];
const emojiProperties: readonly string[] = ['Emoji', 'Emoji_Presentation', 'Emoji_Modifier', 'Emoji_Modifier_Base'];
const joiningTypes: readonly string[] = ['D', 'L', 'R', 'T', 'C'];
const scalar = (cp: unknown): cp is number => Number.isInteger(cp) && typeof cp === 'number' && cp >= 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff);

function ranges(value: unknown, properties?: readonly string[]): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  const previous = new Map<string, number>();
  let lastStart = -1, lastEnd = -1, lastProperty = '';
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== (properties ? 3 : 2)) return false;
    const [start, end, property = ''] = row;
    if (!scalar(start) || !scalar(end) || end < start || (start < 0xd800 && end > 0xdfff)) return false;
    if (typeof property !== 'string' || (properties && !properties.includes(property))) return false;
    // A binary property table may overlap another property, but never itself. Enumerated joining types may not overlap at all.
    const group = properties === emojiProperties ? property : '';
    if (start <= (previous.get(group) ?? -1)) return false;
    if (start < lastStart || (start === lastStart && (end < lastEnd || (end === lastEnd && property <= lastProperty)))) return false;
    previous.set(group, end); lastStart = start; lastEnd = end; lastProperty = property;
  }
  return true;
}

function identifiers(value: unknown, pattern: RegExp): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  let previous = '';
  for (const item of value) {
    if (typeof item !== 'string' || !pattern.test(item) || item <= previous) return false;
    previous = item;
  }
  return true;
}

/** Strict shape/order/default validation. Hash verification belongs to the supplier below, never to caller metadata. */
export function validateModelIngressUnicodeData(value: unknown): value is ModelIngressUnicodeData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key))) return false;
  const pin = MODEL_INGRESS_UNICODE_IDENTITY;
  if (data.schemaVersion !== pin.schemaVersion || data.ucdVersion !== pin.ucdVersion || data.emojiVersion !== pin.emojiVersion
    || data.cldrVersion !== pin.cldrVersion || data.cldrCommit !== pin.cldrCommit || data.joiningTypeDefault !== 'U' || data.scope !== scope) return false;
  if (!rangeKeys.every(key => ranges(data[key])) || !ranges(data.emojiPropertyRanges, emojiProperties) || !ranges(data.joiningTypeRanges, joiningTypes)) return false;
  if (!Array.isArray(data.emojiVariationSequences) || data.emojiVariationSequences.length === 0) return false;
  let previousBase = -1, previousSelector = -1;
  for (const row of data.emojiVariationSequences) {
    if (!Array.isArray(row) || row.length !== 2) return false;
    const [base, selector] = row;
    if (!scalar(base) || (selector !== 0xfe0e && selector !== 0xfe0f) || base < previousBase
      || (base === previousBase && selector <= previousSelector)) return false;
    previousBase = base; previousSelector = selector;
  }
  return identifiers(data.validAlpha2FlagRegions, /^[A-Z]{2}$/) && identifiers(data.validNumericTagRegions, /^[0-9]{3}$/)
    && identifiers(data.validTagSubdivisions, /^[a-z]{2}[a-z0-9]+$/);
}

function freezeData(data: ModelIngressUnicodeData): ModelIngressUnicodeData {
  for (const value of Object.values(data)) {
    if (!Array.isArray(value)) continue;
    for (const row of value) if (Array.isArray(row)) Object.freeze(row);
    Object.freeze(value);
  }
  return Object.freeze(data);
}

/** Snapshot → SHA256 actual bytes against the fixed source pin → parse → validate → freeze.
 * Composition supplies complete asset bytes once; no filesystem/network/domain callbacks or caller-supplied hash.
 * Absence/mismatch is preparation unavailable, never a raw fallback or a security-policy decision.
 */
export function prepareModelIngressUnicodeContext(bytes: Uint8Array | undefined): ModelIngressContextResult {
  if (bytes === undefined) return Object.freeze({ status: 'unavailable', reason: 'missing-data' });
  if (!(bytes instanceof Uint8Array)) return Object.freeze({ status: 'unavailable', reason: 'invalid-input' });
  const snapshot = Buffer.from(bytes);
  if (createHash('sha256').update(snapshot).digest('hex') !== MODEL_INGRESS_UNICODE_IDENTITY.dataSha256) {
    return Object.freeze({ status: 'unavailable', reason: 'data-hash-mismatch' });
  }
  let data: unknown;
  try { data = JSON.parse(snapshot.toString('utf8')); } catch { return Object.freeze({ status: 'unavailable', reason: 'invalid-data' }); }
  if (!validateModelIngressUnicodeData(data)) return Object.freeze({ status: 'unavailable', reason: 'invalid-data' });
  const context = Object.freeze({ identity: MODEL_INGRESS_UNICODE_IDENTITY, data: freezeData(data) }) as ModelIngressUnicodeContext;
  contexts.add(context);
  return Object.freeze({ status: 'ready', context });
}

/** Structural copies, forged version/hash assertions and relabelled snapshots are not supplier contexts. */
export function isModelIngressUnicodeContext(value: unknown): value is ModelIngressUnicodeContext {
  return typeof value === 'object' && value !== null && contexts.has(value);
}
