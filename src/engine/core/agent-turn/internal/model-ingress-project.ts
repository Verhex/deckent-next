import { MODEL_INGRESS_FIELD_TEXT_ENCODING, MODEL_INGRESS_MODEL_TEXT_ENCODING, modelIngressTextDigest } from './model-ingress-field-framing.js';

const BIDI_CONTROL = /^\p{Bidi_Control}$/u;
const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;
/** ZWJ and VS15/16 stay in the text. Orphan ZWJ and an unpaired selector are a disclosed limit: the legitimacy grammar is not closed.
 * ZWNJ, LRM and RLM are marked, never removed from the raw field and never treated as a natural-language allow. */
const KEPT = new Set<number>([0x200d, 0xfe0e, 0xfe0f]);

export type ModelIngressDisposition = 'unchanged' | 'note' | 'quarantine';
export type ModelIngressProjection = {
  readonly modelText: string;
  readonly withheld: string;
  readonly fieldDigest: string;
  readonly projectedDigest: string;
  readonly decodedDigest: string | null;
  readonly codePoints: number;
  readonly decoded: string;
  readonly disposition: ModelIngressDisposition;
};

function marked(char: string): boolean {
  const codePoint = char.codePointAt(0)!;
  if (KEPT.has(codePoint)) return false;
  if (BIDI_CONTROL.test(char) || DEFAULT_IGNORABLE.test(char)) return true;
  return (codePoint >= 0xfe00 && codePoint <= 0xfe0d) || (codePoint >= 0xe0100 && codePoint <= 0xe01ef);
}

function hex(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Tag characters become ASCII. Eight zero-width bits (ZWSP=0, ZWNJ=1) become one byte. Nothing here is model text. */
function decodeHidden(text: string): string {
  let decoded = '', bits = '';
  const flush = () => {
    while (bits.length >= 8) { decoded += String.fromCharCode(Number.parseInt(bits.slice(0, 8), 2)); bits = bits.slice(8); }
    bits = '';
  };
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint >= 0xe0020 && codePoint <= 0xe007e) { flush(); decoded += String.fromCharCode(codePoint - 0xe0000); continue; }
    if (codePoint === 0x200b) { bits += '0'; continue; }
    if (codePoint === 0x200c) { bits += '1'; continue; }
    flush();
  }
  flush();
  return decoded;
}

function shield(segment: string): string {
  return segment.replaceAll('[hidden-unicode:', '[hidden-unicode\\:');
}

/**
 * One projection of a raw model-bound field. The field digest frames the original UTF-16 units.
 * Marked runs become a note; the raw string is not mutated. A decoded payload is returned beside the model text and never copied into it.
 * No markable scalar: the text is returned unchanged, including a note this function already produced.
 */
export function projectModelIngressField(text: string): ModelIngressProjection {
  const field = modelIngressTextDigest(text, MODEL_INGRESS_FIELD_TEXT_ENCODING);
  const prefix = field.sha256.slice(0, 12);
  let codePoints = 0, offset = 0, cursor = 0, modelText = '';
  let runStart = -1, runCount = 0, runFirst = 0, runLast = 0;
  const close = (end: number) => {
    if (runCount === 0) return;
    const range = runCount === 1 ? `${runStart}-${end} ${hex(runFirst)}` : `${runStart}-${end} ${hex(runFirst)}..${hex(runLast)}`;
    modelText += `[hidden-unicode: ${runCount} cp, ${range}, ${prefix}]`;
    codePoints += runCount;
    runCount = 0; runStart = -1;
  };
  for (const char of text) {
    if (marked(char)) {
      if (runCount === 0) { modelText += shield(text.slice(cursor, offset)); runStart = offset; runFirst = char.codePointAt(0)!; }
      runLast = char.codePointAt(0)!; runCount += 1;
    } else if (runCount > 0) { close(offset); cursor = offset; }
    offset += char.length;
  }
  if (runCount > 0) close(offset);
  else if (codePoints === 0) {
    const withheld = `[deckent] result withheld: hidden payload (0 cp, ${prefix})`;
    return Object.freeze({ modelText: text, withheld, fieldDigest: field.sha256, projectedDigest: field.sha256, decodedDigest: null,
      codePoints: 0, decoded: '', disposition: 'unchanged' });
  } else modelText += shield(text.slice(cursor));
  const decoded = decodeHidden(text);
  const projected = modelIngressTextDigest(modelText, MODEL_INGRESS_MODEL_TEXT_ENCODING);
  const withheld = `[deckent] result withheld: hidden payload (${codePoints} cp, ${prefix})`;
  const decodedDigest = decoded.length > 0 ? modelIngressTextDigest(decoded, MODEL_INGRESS_MODEL_TEXT_ENCODING).sha256 : null;
  return Object.freeze({ modelText, withheld, fieldDigest: field.sha256, projectedDigest: projected.sha256, decodedDigest,
    codePoints, decoded, disposition: decoded.length > 0 ? 'quarantine' : 'note' });
}

