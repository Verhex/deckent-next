import { describe, expect, it } from 'vitest';
import { MODEL_INVOCATION_DELTA_TEXT_MAX, modelInvocationDeltaSchema, splitModelInvocationDelta } from '#domain/index.js';

describe('model invocation delta edges', () => {
  it('accepts text of exactly 1 and exactly the maximum length', () => {
    expect(modelInvocationDeltaSchema.safeParse({ kind: 'text', text: 'a' }).success).toBe(true);
    expect(modelInvocationDeltaSchema.safeParse({ kind: 'reasoning', text: 'a'.repeat(MODEL_INVOCATION_DELTA_TEXT_MAX) }).success).toBe(true);
  });

  it('refuses empty text with a too_small issue on the text path', () => {
    const result = modelInvocationDeltaSchema.safeParse({ kind: 'text', text: '' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ code: 'too_small', path: ['text'] });
  });

  it('refuses text one code unit over the maximum with a too_big issue', () => {
    const result = modelInvocationDeltaSchema.safeParse({ kind: 'reasoning', text: 'a'.repeat(MODEL_INVOCATION_DELTA_TEXT_MAX + 1) });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ code: 'too_big', path: ['text'] });
  });

  it('refuses an unknown kind with an invalid_union_discriminator issue', () => {
    const result = modelInvocationDeltaSchema.safeParse({ kind: 'answer', text: 'x' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ code: 'invalid_union_discriminator', path: ['kind'] });
  });

  it('refuses unknown extra keys (strict) and missing text', () => {
    const extra = modelInvocationDeltaSchema.safeParse({ kind: 'text', text: 'x', extra: 1 });
    expect(extra.success).toBe(false);
    expect(extra.error?.issues[0]).toMatchObject({ code: 'unrecognized_keys', keys: ['extra'] });
    expect(modelInvocationDeltaSchema.safeParse({ kind: 'text' }).success).toBe(false);
  });

  it('keeps reasoning distinct from text and returns a readonly parse result', () => {
    const parsed = modelInvocationDeltaSchema.parse({ kind: 'reasoning', text: 'think' });
    expect(parsed.kind).toBe('reasoning');
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('splits at the maximum, every chunk valid, and rejoins losslessly', () => {
    const text = 'b'.repeat(MODEL_INVOCATION_DELTA_TEXT_MAX * 2 + 5);
    const parts = splitModelInvocationDelta('text', text);
    expect(parts.map((p) => p.text.length)).toEqual([MODEL_INVOCATION_DELTA_TEXT_MAX, MODEL_INVOCATION_DELTA_TEXT_MAX, 5]);
    expect(parts.every((p) => modelInvocationDeltaSchema.safeParse(p).success && Object.isFrozen(p))).toBe(true);
    expect(parts.map((p) => p.text).join('')).toBe(text);
  });

  it('returns no deltas for empty text', () => {
    expect(splitModelInvocationDelta('text', '')).toEqual([]);
  });

  it('never separates a surrogate pair at a chunk boundary', () => {
    const text = 'a😀b😀😀c';
    const parts = splitModelInvocationDelta('reasoning', text, 2);
    expect(parts.map((p) => p.text).join('')).toBe(text);
    for (const p of parts) {
      expect(p.kind).toBe('reasoning');
      expect(p.text).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/);
    }
  });

  it('clamps an oversize or tiny maxCodeUnits and still terminates', () => {
    expect(splitModelInvocationDelta('text', 'abc', 0).map((p) => p.text)).toEqual(['ab', 'c']);
    expect(splitModelInvocationDelta('text', 'abc', 1e9)).toHaveLength(1);
  });
});
