import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandCldrStringRange, generateModelIngressUnicode, parseCldrValidity, parseEmojiVariations, parseUnicodeRanges, runModelIngressUnicodeGenerator } from '../../../scripts/generate-model-ingress-unicode.mjs';

const goldens = JSON.parse(readFileSync(new URL('../../fixtures/model-ingress/parser-goldens.json', import.meta.url), 'utf8')) as {
  stringRanges: { source: string; expanded: string[] }[];
  lookupCounts: { validAlpha2Flags: number; validNumericTagRegions: number; validTagSubdivisions: number; variationSequences: number };
};

describe('MODEL-INGRESS offline primary-data generator', () => {
  it.each(goldens.stringRanges)('revalidates the Cartesian StringRange golden $source', ({ source, expanded }) => {
    expect(expandCldrStringRange(source)).toEqual(expanded);
  });

  it('regenerates the complete pinned asset from retained original source bytes with no network', () => {
    const generated = generateModelIngressUnicode();
    const asset = readFileSync(new URL('../../../src/domain/core/text/data/model-ingress-unicode-17-cldr48-2.json', import.meta.url), 'utf8');
    expect(generated).toBe(asset);
    expect(createHash('sha256').update(generated).digest('hex')).toBe('c81b40d719cfbe73963c630d4044ad03731c9fe42983042c92a0aafced708cd0');
    const data = JSON.parse(generated);
    expect(data.validAlpha2FlagRegions).toHaveLength(goldens.lookupCounts.validAlpha2Flags);
    expect(data.validNumericTagRegions).toHaveLength(goldens.lookupCounts.validNumericTagRegions);
    expect(data.validTagSubdivisions).toHaveLength(goldens.lookupCounts.validTagSubdivisions);
    expect(data.emojiVariationSequences).toHaveLength(goldens.lookupCounts.variationSequences);
  });

  it('refuses missing or drifted external primary data before producing any asset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-ingress-source-'));
    try {
      expect(() => generateModelIngressUnicode(dir)).toThrow();
      writeFileSync(join(dir, 'emoji-data-17.txt'), 'forged source with correct filename');
      expect(() => generateModelIngressUnicode(dir)).toThrow('MODEL_INGRESS_SOURCE_MISMATCH:emoji-data-17.txt');
      const output = join(dir, 'asset.json');
      writeFileSync(output, 'existing asset');
      expect(() => runModelIngressUnicodeGenerator(['--source-dir', dir, '--out', output]))
        .toThrow('MODEL_INGRESS_SOURCE_MISMATCH:emoji-data-17.txt');
      expect(readFileSync(output, 'utf8')).toBe('existing asset');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps the original Unicode copyright and permission notice beside the derived asset', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../scripts/data/model-ingress-unicode-sources.json', import.meta.url), 'utf8'));
    const license = manifest.sources.find((source: { file: string }) => source.file === 'license-unicode.txt');
    const retained = readFileSync(new URL('../../../src/domain/core/text/data/LICENSE.unicode.txt', import.meta.url));
    expect(manifest.license).toBe('Unicode-3.0');
    expect(retained.length).toBe(license.bytes);
    expect(createHash('sha256').update(retained).digest('hex')).toBe(license.sha256);
  });

  it('ignores comments, preserves property overlaps, and rejects duplicates within one property', () => {
    expect(parseUnicodeRanges('# header\n0042 ; Emoji\n0041..0042 ; Emoji_Presentation # comment\n'))
      .toEqual([[65, 66, 'Emoji_Presentation'], [66, 66, 'Emoji']]);
    expect(() => parseUnicodeRanges('0041..0042 ; Emoji\n0042 ; Emoji')).toThrow('MODEL_INGRESS_UCD_RANGE_OVERLAP');
    expect(() => parseUnicodeRanges('0042..0041 ; Emoji')).toThrow('MODEL_INGRESS_UCD_RANGE_INVALID');
    expect(() => parseUnicodeRanges('110000 ; Emoji')).toThrow('MODEL_INGRESS_UCD_RANGE_INVALID');
    expect(() => parseUnicodeRanges('0041 ; Emoji ; forged')).toThrow('MODEL_INGRESS_UCD_RANGE_INVALID');
  });

  it('parses exact variation pairs and rejects forged, repeated or malformed selectors', () => {
    expect(parseEmojiVariations('0023 FE0F ; emoji style; # comment\n0023 FE0E ; text style;'))
      .toEqual([[35, 0xfe0e], [35, 0xfe0f]]);
    expect(() => parseEmojiVariations('0023 FE01 ; text style;')).toThrow('MODEL_INGRESS_VARIATION_INVALID');
    expect(() => parseEmojiVariations('D800 FE0E ; text style;')).toThrow('MODEL_INGRESS_VARIATION_INVALID');
    expect(() => parseEmojiVariations('0023 FE0E ; text style;\n0023 FE0E ; text style;')).toThrow('MODEL_INGRESS_VARIATION_DUPLICATE');
  });

  it('reads only CLDR validity IDs, without treating comments or external DTDs as data', () => {
    const xml = `<!DOCTYPE supplementalData SYSTEM 'unavailable.dtd'><idValidity>
      <!-- <id type='region' idStatus='regular'>ZZ</id> -->
      <id type='region' idStatus='regular'>AC~G</id>
      <id type='region' idStatus='deprecated'>AN</id></idValidity>`;
    expect(parseCldrValidity(xml, 'region')).toEqual({ regular: ['AC', 'AD', 'AE', 'AF', 'AG'], deprecated: ['AN'] });
    expect(() => parseCldrValidity(xml.replace('AC~G', 'AC AC'), 'region')).toThrow('MODEL_INGRESS_CLDR_VALIDITY_DUPLICATE');
    expect(() => parseCldrValidity(xml, 'subdivision')).toThrow('MODEL_INGRESS_CLDR_VALIDITY_INVALID');
    expect(() => parseCldrValidity(xml.replace("idStatus='deprecated'", "idStatus='regular'"), 'region')).toThrow('MODEL_INGRESS_CLDR_VALIDITY_INVALID');
  });

  it.each(['ab~a', 'ab~abc', 'ab~cd~ef', 'ab~', '', '&entity;'])('refuses malformed StringRange %s', token => {
    expect(() => expandCldrStringRange(token)).toThrow();
  });
});
