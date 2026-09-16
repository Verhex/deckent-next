import { describe, expect, it } from 'vitest';
import { dispatch } from '../../../src/surfaces/index.js';

describe('surfaces/cli dispatch contract', () => {
  it('--version reports package identity with exit 0', () => {
    const r = dispatch(['--version']);
    expect(r.code).toBe(0);
    expect(r.output).toMatch(/^deckent v\d+\.\d+\.\d+/);
  });
  it('no arguments prints help with exit 0', () => {
    expect(dispatch([]).code).toBe(0);
  });
  it('unknown command exits 2 and names the command', () => {
    const r = dispatch(['frobnicate']);
    expect(r.code).toBe(2);
    expect(r.output).toContain('frobnicate');
  });
});
