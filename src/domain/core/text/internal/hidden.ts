/** Human display classification only; source strings, logical order and UTF-16 units are retained.
 * This is not ANSI sanitization, Unicode normalization, model ingress or streaming assembly.
 * Callers assemble complete text before classification and keep raw custody/digests separately.
 */
export type HiddenTextContext = 'exact' | 'prose';
export type HiddenTextCategory = 'bidi-control' | 'default-ignorable';
type SourceSpan = { readonly source: string; readonly start: number; readonly end: number };
export type HiddenTextToken =
  | (SourceSpan & { readonly kind: 'text' })
  | (SourceSpan & { readonly kind: 'marker'; readonly codePoint: number; readonly category: HiddenTextCategory });
export type HiddenTextClassification = { readonly tokens: readonly HiddenTextToken[]; readonly hiddenCount: number };

// No global flag: repeated calls cannot inherit RegExp.lastIndex. The properties use the host Unicode table.
const BIDI_CONTROL = /^\p{Bidi_Control}$/u;
const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;
const explicitBidi = (cp: number) => (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);

/** PLAN TEXT-HIDDEN-MARKS: exact marks all Bidi_Control/default-ignorable code points;
 * prose marks only explicit embeddings, overrides and isolates (including PDF/PDI).
 * Every marker retains its raw source but a renderer must display a trusted code-point marker,
 * with its own style and count. Never emit marker.source as visible text or execute a projection.
 * start/end are zero-based UTF-16 offsets, end exclusive, directly usable with String.slice.
 * Lone surrogates, ANSI, C0/C1 and LS/PS remain text: their existing boundary owners are unchanged.
 */
export function classifyHiddenText(text: string, context: HiddenTextContext): HiddenTextClassification {
  const tokens: HiddenTextToken[] = [];
  let offset = 0, textStart = 0, hiddenCount = 0;
  for (const source of text) {
    const codePoint = source.codePointAt(0)!;
    const bidi = BIDI_CONTROL.test(source);
    const mark = context === 'prose' ? explicitBidi(codePoint) : bidi || DEFAULT_IGNORABLE.test(source);
    if (mark) {
      if (textStart < offset) tokens.push({ kind: 'text', source: text.slice(textStart, offset), start: textStart, end: offset });
      const end = offset + source.length;
      tokens.push({ kind: 'marker', source, start: offset, end, codePoint, category: bidi ? 'bidi-control' : 'default-ignorable' });
      hiddenCount += 1;
      textStart = end;
    }
    offset += source.length;
  }
  if (textStart < text.length) tokens.push({ kind: 'text', source: text.slice(textStart), start: textStart, end: text.length });
  return { tokens, hiddenCount };
}
