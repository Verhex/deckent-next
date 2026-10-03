import { describe, expect, it } from 'vitest';
import { modelTextBoundary, modelTextPrefix, wellFormedModelJson, wellFormedModelText } from '#domain/index.js';

const EMOJI = '\u{1F600}';
const HIGH = '\uD83D';
const LOW = '\uDE00';

describe('agent-tool text edges', () => {
  it('modelTextBoundary moves back only inside a pair and clamps out-of-range indexes', () => {
    const text = `a${EMOJI}b`;
    expect(modelTextBoundary(text, 2)).toBe(1);
    expect(modelTextBoundary(text, 1)).toBe(1);
    expect(modelTextBoundary(text, 3)).toBe(3);
    expect(modelTextBoundary(text, -5)).toBe(0);
    expect(modelTextBoundary(text, 99)).toBe(text.length);
    expect(modelTextBoundary(text, 2.9)).toBe(1);
    expect(modelTextBoundary('', 3)).toBe(0);
  });

  it('modelTextBoundary leaves a cut between lone halves alone and maps NaN to a valid index', () => {
    expect(modelTextBoundary(`${LOW}${HIGH}`, 1)).toBe(1);
    expect(modelTextBoundary(`${HIGH}x`, 1)).toBe(1);
    expect(modelTextBoundary('abc', Number.NaN)).toBe(0);
  });

  it('modelTextPrefix never splits an emoji and keeps multi-byte BMP characters whole', () => {
    expect(modelTextPrefix(`ab${EMOJI}`, 3)).toBe('ab');
    expect(modelTextPrefix(`ab${EMOJI}`, 4)).toBe(`ab${EMOJI}`);
    expect(modelTextPrefix('çğış', 2)).toBe('çğ');
    expect(modelTextPrefix(EMOJI, 1)).toBe('');
  });

  it('modelTextPrefix handles empty, zero, negative and infinite limits', () => {
    expect(modelTextPrefix('', 5)).toBe('');
    expect(modelTextPrefix('abc', 0)).toBe('');
    expect(modelTextPrefix('abc', -1)).toBe('');
    expect(modelTextPrefix('abc', Infinity)).toBe('abc');
    expect(modelTextPrefix(`x${EMOJI}`, 2).length).toBeLessThanOrEqual(2);
  });

  it('wellFormedModelText replaces every lone surrogate with U+FFFD and keeps pairs', () => {
    expect(wellFormedModelText(`${HIGH}`)).toBe('�');
    expect(wellFormedModelText(`${LOW}`)).toBe('�');
    expect(wellFormedModelText(`${LOW}${HIGH}`)).toBe('��');
    expect(wellFormedModelText(`${HIGH}${HIGH}${LOW}`)).toBe(`�${EMOJI}`);
    expect(wellFormedModelText(`a${EMOJI}b`)).toBe(`a${EMOJI}b`);
    expect(wellFormedModelText('')).toBe('');
  });

  it('wellFormedModelText result is always well formed and idempotent', () => {
    const out = wellFormedModelText(`${HIGH}x${LOW}${EMOJI}${HIGH}`);
    expect(out.isWellFormed()).toBe(true);
    expect(wellFormedModelText(out)).toBe(out);
  });

  it('wellFormedModelJson returns the identical reference when nothing needs a change', () => {
    const value = { a: ['x', { b: EMOJI }], n: 1, z: null, t: true };
    expect(wellFormedModelJson(value)).toBe(value);
    expect(wellFormedModelJson(null)).toBeNull();
    expect(wellFormedModelJson(7)).toBe(7);
  });

  it('wellFormedModelJson repairs nested values and keys without mutating the input', () => {
    const value = { [`k${HIGH}`]: [`v${LOW}`, 2], ok: { deep: HIGH } };
    const out = wellFormedModelJson(value);
    expect(out).toEqual({ 'k�': ['v�', 2], ok: { deep: '�' } });
    expect(Object.keys(value)[0]).toBe(`k${HIGH}`);
    expect(value.ok.deep).toBe(HIGH);
    expect(JSON.stringify(out)).not.toMatch(/\\ud[89a-f]/i);
  });

  it('wellFormedModelJson keeps untouched siblings by reference when only one branch changes', () => {
    const untouched = { s: 'fine' };
    const out = wellFormedModelJson({ untouched, bad: HIGH });
    expect(out.untouched).toBe(untouched);
    expect(out.bad).toBe('�');
  });
});
