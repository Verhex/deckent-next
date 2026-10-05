import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// The admitted lane owns leaves; main owns the public barrel fan-in.
// eslint-disable-next-line no-restricted-imports
import { isModelIngressUnicodeContext, MODEL_INGRESS_UNICODE_IDENTITY, prepareModelIngressUnicodeContext, validateModelIngressUnicodeData } from '#engine/core/agent-turn/internal/model-ingress-context.js';

const bytes = readFileSync(new URL('../../../src/domain/core/text/data/model-ingress-unicode-17-cldr48-2.json', import.meta.url));
const lookup = () => JSON.parse(bytes.toString('utf8'));

describe('MODEL-INGRESS pinned lookup supplier', () => {
  it('recomputes the actual pinned asset digest before producing immutable facts', () => {
    expect(bytes.length).toBe(124155);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(MODEL_INGRESS_UNICODE_IDENTITY.dataSha256);
    const result = prepareModelIngressUnicodeContext(bytes);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Expected the pinned context');
    expect(isModelIngressUnicodeContext(result.context)).toBe(true);
    expect(result.context.identity).toEqual(MODEL_INGRESS_UNICODE_IDENTITY);
    expect(result.context.data).toEqual(lookup());
    expect(result.context.data.validAlpha2FlagRegions).toHaveLength(271);
    expect(result.context.data.validNumericTagRegions).toHaveLength(31);
    expect(result.context.data.validTagSubdivisions).toHaveLength(5653);
    expect(result.context.data.emojiVariationSequences).toHaveLength(742);
    expect(result.context.data.validTagSubdivisions).toEqual(expect.arrayContaining(['gbeng', 'gbsct', 'gbwls', 'usca']));
    expect(result.context.data.validNumericTagRegions).toContain('001');
    expect(result.context.data.validAlpha2FlagRegions).toEqual(expect.arrayContaining(['EU', 'UN', 'TR']));
    expect(result.context.data.validTagSubdivisions).not.toContain('zz999');
    expect(result.context.data.joiningTypeDefault).toBe('U');
    for (const value of [result, result.context, result.context.identity, result.context.data, ...Object.values(result.context.data).filter(Array.isArray)]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(result.context.data.emojiPropertyRanges.every(Object.isFrozen)).toBe(true);
    expect(result.context.data.joiningTypeRanges.every(Object.isFrozen)).toBe(true);
    expect(result.context.data.emojiVariationSequences.every(Object.isFrozen)).toBe(true);
  });

  it('keeps source mutation outside context custody, and rejects forged/copied supplier values', () => {
    const input = Buffer.from(bytes), result = prepareModelIngressUnicodeContext(input);
    if (result.status !== 'ready') throw new Error('Expected the pinned context');
    input.fill(0);
    expect(result.context.data.ucdVersion).toBe('17.0.0');
    expect(isModelIngressUnicodeContext({ ...result.context })).toBe(false);
    expect(isModelIngressUnicodeContext(structuredClone(result.context))).toBe(false);
    expect(isModelIngressUnicodeContext({ identity: MODEL_INGRESS_UNICODE_IDENTITY, verified: true })).toBe(false);
    expect(() => { (result.context.data.emojiVariationSequences[0] as number[])[0] = 65; }).toThrow(TypeError);
    expect(() => { (result.context.identity as { ucdVersion: string }).ucdVersion = '18.0.0'; }).toThrow(TypeError);
  });

  it('returns typed unavailable for missing/callback data without raw fallback', () => {
    expect(prepareModelIngressUnicodeContext(undefined)).toEqual({ status: 'unavailable', reason: 'missing-data' });
    expect(prepareModelIngressUnicodeContext((() => bytes) as unknown as Uint8Array)).toEqual({ status: 'unavailable', reason: 'invalid-input' });
    expect(prepareModelIngressUnicodeContext({ data: bytes, sha256: MODEL_INGRESS_UNICODE_IDENTITY.dataSha256, verified: true } as unknown as Uint8Array))
      .toEqual({ status: 'unavailable', reason: 'invalid-input' });
  });

  it('rejects version relabelling, changed facts and serialization changes despite caller-copied identity', () => {
    const changed = lookup();
    changed.emojiVariationSequences[0][0] = 65;
    const relabelled = lookup();
    relabelled.ucdVersion = '18.0.0';
    for (const input of [Buffer.from(JSON.stringify(changed)), Buffer.from(JSON.stringify(relabelled)), Buffer.from(bytes.toString('utf8').trimEnd())]) {
      expect(prepareModelIngressUnicodeContext(input)).toEqual({ status: 'unavailable', reason: 'data-hash-mismatch' });
    }
  });

  it.each([
    ['unknown key', (data: Record<string, unknown>) => { data.classification = []; }],
    ['changed version', (data: Record<string, unknown>) => { data.ucdVersion = '18.0.0'; }],
    ['wrong default', (data: Record<string, unknown>) => { data.joiningTypeDefault = 'T'; }],
    ['overlap', (data: Record<string, unknown>) => { data.letterRanges = [[65, 90], [90, 100]]; }],
    ['reordered', (data: Record<string, unknown>) => { data.viramaRanges = [[100, 110], [90, 95]]; }],
    ['duplicate', (data: Record<string, unknown>) => { data.nonspacingMarkRanges = [[65, 65], [65, 65]]; }],
    ['surrogate', (data: Record<string, unknown>) => { data.dependentVowelRanges = [[0xd800, 0xd800]]; }],
    ['surrogate crossing', (data: Record<string, unknown>) => { data.letterRanges = [[0xd7ff, 0xe000]]; }],
    ['past Unicode', (data: Record<string, unknown>) => { data.viramaRanges = [[0x110000, 0x110000]]; }],
    ['noninteger', (data: Record<string, unknown>) => { data.letterRanges = [[65.5, 90]]; }],
    ['invalid property', (data: Record<string, unknown>) => { data.emojiPropertyRanges = [[65, 65, 'CallerAllowed']]; }],
    ['binary overlap', (data: Record<string, unknown>) => { data.emojiPropertyRanges = [[65, 70, 'Emoji'], [70, 80, 'Emoji']]; }],
    ['enumerated overlap', (data: Record<string, unknown>) => { data.joiningTypeRanges = [[65, 70, 'D'], [70, 80, 'T']]; }],
    ['invalid VS', (data: Record<string, unknown>) => { data.emojiVariationSequences = [[35, 0xfe01]]; }],
    ['duplicate VS', (data: Record<string, unknown>) => { data.emojiVariationSequences = [[35, 0xfe0e], [35, 0xfe0e]]; }],
    ['duplicate region', (data: Record<string, unknown>) => { data.validAlpha2FlagRegions = ['TR', 'TR']; }],
    ['invalid subdivision', (data: Record<string, unknown>) => { data.validTagSubdivisions = ['USCA']; }],
    ['missing table', (data: Record<string, unknown>) => { delete data.viramaRanges; }],
  ])('rejects malformed shape: %s', (_name, mutate) => {
    const data = lookup();
    mutate(data);
    expect(validateModelIngressUnicodeData(data)).toBe(false);
  });
});
