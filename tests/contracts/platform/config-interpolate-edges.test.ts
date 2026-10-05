import { describe, expect, it } from 'vitest';
import { parseSecretReference, resolveConfigSecrets } from '../../../src/platform/core/config/index.js';
import { redactForDecision } from '#platform/index.js';
import { DeckentError } from '../../../src/platform/core/errors/index.js';

describe('parseSecretReference edges', () => {
  it('accepts only the exact grammar', () => {
    expect(parseSecretReference('$DECK:_A1')).toBe('_A1');
    for (const bad of ['$DECK:', '$DECK:1A', '$DECK:a', '$DECK:A-B', ' $DECK:A', '$DECK:A\n', 'x$DECK:A', '$DECK:A$DECK:B', '${DECK:A}'])
      expect(parseSecretReference(bad)).toBeUndefined();
  });
  it('refuses non-string input', () => {
    for (const bad of [undefined, null, 1, {}, ['$DECK:A']]) expect(parseSecretReference(bad)).toBeUndefined();
  });
});

describe('resolveConfigSecrets edges', () => {
  it('does not interpolate embedded or malformed markers', async () => {
    const calls: string[] = [];
    const cfg = { a: 'pre $DECK:A', b: '$DECK:', c: '$$DECK:A' };
    const r = await resolveConfigSecrets(cfg, async k => { calls.push(k); return 'x'; });
    expect(r.config).toEqual(cfg);
    expect(calls).toEqual([]);
    expect(r.secretPaths).toEqual([]);
  });
  it('resolves each key once and escapes JSON-pointer paths', async () => {
    let n = 0;
    const r = await resolveConfigSecrets({ 'a/b~c': ['$DECK:K', { x: '$DECK:K' }] }, async () => `v${++n}`);
    expect(n).toBe(1);
    expect(r.config).toEqual({ 'a/b~c': ['v1', { x: 'v1' }] });
    expect(r.secretPaths).toEqual(['/a~1b~0c/0', '/a~1b~0c/1/x']);
    expect(r.references).toEqual(['K']);
    expect(Object.isFrozen(r.secretPaths)).toBe(true);
  });
  it('keeps the reference and reports missing for undefined or empty secrets', async () => {
    const missing: string[] = [];
    const r = await resolveConfigSecrets({ a: '$DECK:A', b: '$DECK:B' }, async k => (k === 'A' ? undefined : ''), k => missing.push(k));
    expect(r.config).toEqual({ a: '$DECK:A', b: '$DECK:B' });
    expect(missing).toEqual(['A', 'B']);
    expect(r.secretPaths).toEqual([]);
  });
  it('maps foreign resolver failures to a content-free error', async () => {
    await expect(resolveConfigSecrets({ a: '$DECK:A' }, async () => { throw new Error('private /home/x'); }))
      .rejects.toThrow(/^SECRET_RESOLUTION_FAILED$/);
    await expect(resolveConfigSecrets({ a: '$DECK:A' }, async () => { throw new DeckentError('OTHER', 'm'); }))
      .rejects.toThrow(/^SECRET_RESOLUTION_FAILED$/);
  });
  it('preserves typed SECRET_STORE_ refusals', async () => {
    const err = new DeckentError('SECRET_STORE_UNSAFE', 'unsafe');
    await expect(resolveConfigSecrets({ a: '$DECK:A' }, async () => { throw err; })).rejects.toBe(err);
  });
  it('rejects a non-string resolver result', async () => {
    await expect(resolveConfigSecrets({ a: '$DECK:A' }, (async () => 42) as never)).rejects.toThrow('SECRET_RESOLVER_RESULT_INVALID');
  });
  it('passes non-string scalars through and returns null-prototype records', async () => {
    const r = await resolveConfigSecrets({ n: 1, z: null, t: true, o: {} }, async () => 's');
    expect(r.config).toEqual({ n: 1, z: null, t: true, o: {} });
    expect(Object.getPrototypeOf(r.config)).toBeNull();
  });
});

it('B7 snapshots only already resolved names once, keeping raw metadata out of the config and missing references out of the snapshot', async () => {
  let calls = 0;
  const result = await resolveConfigSecrets({ a: '$DECK:TEST_KEY', b: '$DECK:TEST_KEY', missing: '$DECK:MISSING' }, async name => {
    calls++; return name === 'TEST_KEY' ? 'fictitious-config-value' : undefined;
  });
  expect(calls).toBe(2);
  expect(Object.keys(result.config)).toEqual(['a', 'b', 'missing']);
  expect(JSON.stringify(result.knownSecrets)).toBe('{}');
  expect(redactForDecision('echo fictitious-config-value $DECK:MISSING', result.knownSecrets).text).toBe('echo ‹secret:TEST_KEY› $DECK:MISSING');
});
