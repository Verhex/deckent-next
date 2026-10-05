import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
// The admitted lane owns leaves; main owns the public barrel fan-in.
// eslint-disable-next-line no-restricted-imports
import { MODEL_INGRESS_FIELD_TEXT_ENCODING, MODEL_INGRESS_MODEL_TEXT_ENCODING, modelIngressTextDigest } from '#engine/core/agent-turn/internal/model-ingress-field-framing.js';

const goldens = JSON.parse(readFileSync(new URL('../../fixtures/model-ingress/field-framing-goldens.json', import.meta.url), 'utf8')) as {
  encodingVersion: string;
  vectors: { text: string; codeUnits: number; frameHex: string; sha256: string }[];
};

/** A whole-frame oracle, deliberately unlike the production chunk writer. Only test inputs allocate this duplicate. */
function oracle(text: string, encoding: string): Buffer {
  const prefix = Buffer.from(encoding + '\0', 'ascii'), frame = Buffer.alloc(prefix.length + 8 + text.length * 2);
  prefix.copy(frame);
  frame.writeBigUInt64BE(BigInt(text.length), prefix.length);
  for (let i = 0; i < text.length; i += 1) frame.writeUInt16BE(text.charCodeAt(i), prefix.length + 8 + i * 2);
  return frame;
}

describe('MODEL-INGRESS original field framing', () => {
  it.each(goldens.vectors)('revalidates the external vector $frameHex', ({ text, codeUnits, frameHex, sha256 }) => {
    expect(goldens.encodingVersion).toBe(MODEL_INGRESS_FIELD_TEXT_ENCODING);
    const bytes = oracle(text, MODEL_INGRESS_FIELD_TEXT_ENCODING);
    expect(bytes.toString('hex')).toBe(frameHex);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
    expect(modelIngressTextDigest(text, MODEL_INGRESS_FIELD_TEXT_ENCODING)).toEqual({ encodingVersion: goldens.encodingVersion, codeUnits, sha256 });
  });

  it('separates every lone surrogate and normalized lookalike without altering text', () => {
    const values = ['\ud800', '\ud801', '\ufffd', '\u00e9', 'e\u0301', '', 'A', 'A\0'];
    expect(new Set(values.map(text => modelIngressTextDigest(text, MODEL_INGRESS_FIELD_TEXT_ENCODING).sha256)).size).toBe(values.length);
    // Contrary legacy behavior is reproduced, rather than inferred from null values in the external fixture.
    expect(Buffer.from(values[0]!, 'utf8')).toEqual(Buffer.from(values[1]!, 'utf8'));
    expect(modelIngressTextDigest('😀', MODEL_INGRESS_FIELD_TEXT_ENCODING).codeUnits).toBe(2);
  });

  it('keeps model-output framing separate even when visible text is unchanged', () => {
    for (const { text } of goldens.vectors) {
      const projected = modelIngressTextDigest(text, MODEL_INGRESS_MODEL_TEXT_ENCODING);
      expect(projected.sha256).toBe(createHash('sha256').update(oracle(text, MODEL_INGRESS_MODEL_TEXT_ENCODING)).digest('hex'));
      expect(projected.sha256).not.toBe(modelIngressTextDigest(text, MODEL_INGRESS_FIELD_TEXT_ENCODING).sha256);
      expect(Object.isFrozen(projected)).toBe(true);
    }
  });

  it.each([4095, 4096, 4097, 8192, 8193])('hashes complete multi-chunk input of %i units', length => {
    const text = ('A\ud800😀\0e\u0301\u{e0061}').repeat(length).slice(0, length);
    const expected = createHash('sha256').update(oracle(text, MODEL_INGRESS_FIELD_TEXT_ENCODING)).digest('hex');
    expect(modelIngressTextDigest(text, MODEL_INGRESS_FIELD_TEXT_ENCODING).sha256).toBe(expected);
  });

  it('bounds its scratch allocation independently of a large source field', () => {
    const text = '😀\ud800\0'.repeat(100_000);
    const expected = createHash('sha256').update(oracle(text, MODEL_INGRESS_FIELD_TEXT_ENCODING)).digest('hex');
    const allocate = vi.spyOn(Buffer, 'allocUnsafe');
    try {
      expect(modelIngressTextDigest(text, MODEL_INGRESS_FIELD_TEXT_ENCODING).sha256).toBe(expected);
      expect(allocate.mock.calls.map(call => call[0])).toEqual([8192]);
    } finally { allocate.mockRestore(); }
  });

  it('rejects missing text and arbitrary hash domains at the runtime boundary', () => {
    expect(() => modelIngressTextDigest(undefined as unknown as string, MODEL_INGRESS_FIELD_TEXT_ENCODING)).toThrow('MODEL_INGRESS_FIELD_ENCODING_INVALID');
    expect(() => modelIngressTextDigest('A', 'caller-domain' as typeof MODEL_INGRESS_FIELD_TEXT_ENCODING)).toThrow('MODEL_INGRESS_FIELD_ENCODING_INVALID');
  });
});
