import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { classifyHiddenText } from '#domain/core/text/index.js';
import type { HiddenTextClassification, HiddenTextContext } from '#domain/core/text/index.js';

const bidi = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
const raw = (result: HiddenTextClassification) => result.tokens.map(token => token.source).join('');
const markers = (result: HiddenTextClassification) => result.tokens.filter(token => token.kind === 'marker');
const digest = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

describe('B8 human hidden-text classifier', () => {
  it('marks all twelve bidi controls in exact, only nine explicit controls in prose', () => {
    const text = String.fromCodePoint(...bidi);
    const exact = classifyHiddenText(text, 'exact');
    const prose = classifyHiddenText(text, 'prose');
    expect(markers(exact).map(token => token.codePoint)).toEqual(bidi);
    expect(exact.hiddenCount).toBe(12);
    expect(markers(exact).every(token => token.category === 'bidi-control')).toBe(true);
    expect(markers(prose).map(token => token.codePoint)).toEqual(bidi.slice(3));
    expect(prose.hiddenCount).toBe(9);
    expect(prose.tokens[0]).toEqual({ kind: 'text', source: String.fromCodePoint(...bidi.slice(0, 3)), start: 0, end: 3 });
  });

  it('covers hidden families and reserved default-ignorables without contextual exemptions in exact', () => {
    const points = [0x00ad, 0x034f, 0x115f, 0x1160, 0x17b4, 0x180e, 0x200b, 0x200c, 0x200d,
      0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2065, 0x3164, 0xfe00, 0xfe0e, 0xfe0f, 0xfeff,
      0xffa0, 0xfff0, 0xfff8, 0x1bca0, 0x1bca3, 0x1d173, 0x1d17a, 0xe0000, 0xe0041, 0xe007f, 0xe0100, 0xe01ef, 0xe0fff];
    const text = String.fromCodePoint(...points);
    expect(markers(classifyHiddenText(text, 'exact')).map(token => token.codePoint)).toEqual(points);
    expect(classifyHiddenText(text, 'exact').hiddenCount).toBe(points.length);
    expect(classifyHiddenText(text, 'prose')).toEqual({ tokens: [{ kind: 'text', source: text, start: 0, end: text.length }], hiddenCount: 0 });
  });

  it('pins accepted Unicode property coverage, including complete tag and variation-selector ranges', () => {
    const observedBidi: number[] = [];
    let ignorableCount = 0;
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      const source = String.fromCodePoint(cp);
      if (/^\p{Bidi_Control}$/u.test(source)) observedBidi.push(cp);
      if (/^\p{Default_Ignorable_Code_Point}$/u.test(source)) ignorableCount += 1;
    }
    expect(observedBidi).toEqual(bidi);
    expect(ignorableCount).toBe(4174);
    for (const [first, last] of [[0xe0000, 0xe0fff], [0xfe00, 0xfe0f], [0xe0100, 0xe01ef]]) {
      const points = Array.from({ length: last! - first! + 1 }, (_, index) => first! + index);
      expect(markers(classifyHiddenText(String.fromCodePoint(...points), 'exact')).map(token => token.codePoint)).toEqual(points);
    }
  });

  it('keeps multilingual text, marks, joiners, selectors and subregion flags intact in prose', () => {
    const fixtures = ['ığüşöçİĞÜŞÖÇ e\u0301 Ａ', 'العربية\u061c ١٢', 'עברית\u200f \u200e123', 'می\u200cروم',
      'ශ්‍රී', '👩\u200d💻 ❤️︎', '\u200c\u200d\ufe0f\ufe0f', '漢\u{e0100}',
      String.fromCodePoint(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f)];
    for (const text of fixtures) {
      expect(classifyHiddenText(text, 'prose')).toEqual({ tokens: [{ kind: 'text', source: text, start: 0, end: text.length }], hiddenCount: 0 });
      expect(raw(classifyHiddenText(text, 'exact'))).toBe(text);
    }
  });

  it('retains logical order, UTF-16 positions, raw UTF-8 bytes and digest for a hidden command', () => {
    const text = '😀cat notes.txt\u202e; \u{e0072}\u{e006d}\u200b Ａ e\u0301';
    const bytes = Buffer.from(text, 'utf8'), originalDigest = digest(text);
    for (const context of ['exact', 'prose'] as const) {
      const result = classifyHiddenText(text, context);
      expect(raw(result)).toBe(text);
      expect(Buffer.from(raw(result), 'utf8')).toEqual(bytes);
      expect(digest(raw(result))).toBe(originalDigest);
      let offset = 0;
      for (const token of result.tokens) {
        expect(token.start).toBe(offset);
        expect(text.slice(token.start, token.end)).toBe(token.source);
        offset = token.end;
      }
      expect(offset).toBe(text.length);
      expect(result.hiddenCount).toBe(markers(result).length);
    }
    const positions = markers(classifyHiddenText('😀\u{e0041}a\u200b', 'exact')).map(({ start, end, codePoint }) => ({ start, end, codePoint }));
    expect(positions).toEqual([{ start: 2, end: 4, codePoint: 0xe0041 }, { start: 5, end: 6, codePoint: 0x200b }]);
  });

  it('keeps literal marker lookalikes as ordinary text with zero trusted count', () => {
    const text = '⟨U+202E⟩ <U+E0041> [hidden-unicode: 7 cp]';
    for (const context of ['exact', 'prose'] as const) {
      expect(classifyHiddenText(text, context)).toEqual({ tokens: [{ kind: 'text', source: text, start: 0, end: text.length }], hiddenCount: 0 });
    }
  });

  it('leaves ANSI/control/separator and lone-surrogate handling to existing boundary owners', () => {
    const text = '\u001b[8mhidden\u001b[0m\u0000\u009b\n\t\u2028\u2029\udb40\u200b\udc41';
    for (const context of ['exact', 'prose'] as const) {
      const result = classifyHiddenText(text, context);
      expect(raw(result)).toBe(text);
      expect(raw(result)).not.toContain('\u{e0041}');
      expect(result.hiddenCount).toBe(context === 'exact' ? 1 : 0);
    }
    // This classifier is stateless: streaming callers must assemble a pair before classifying it.
    expect(classifyHiddenText('\udb40', 'exact').hiddenCount).toBe(0);
    expect(classifyHiddenText('\udc41', 'exact').hiddenCount).toBe(0);
    expect(classifyHiddenText('\udb40\udc41', 'exact').hiddenCount).toBe(1);
  });

  it('handles empty, adjacent, leading and trailing markers without state leaking between calls', () => {
    expect(classifyHiddenText('', 'exact')).toEqual({ tokens: [], hiddenCount: 0 });
    const text = '\u200b\u202eabc\u200c';
    const contexts: HiddenTextContext[] = ['exact', 'prose', 'exact'];
    for (const context of contexts) {
      const result = classifyHiddenText(text, context);
      expect(raw(result)).toBe(text);
      expect(result.hiddenCount).toBe(context === 'exact' ? 3 : 1);
      expect(result.tokens.every(token => token.end > token.start)).toBe(true);
    }
  });
});
