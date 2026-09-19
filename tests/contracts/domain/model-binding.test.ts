import { describe, expect, it } from 'vitest';
import { encodeModelBindingDefinition, parseModelReference, parseProviderCatalog,
  resolveModelBindingDefinition } from '../../../src/domain/core/provider-catalog/index.js';

const ref = { providerId: 'provider-a', providerVersion: 1, modelId: 'model-a', modelVersion: 2 };
const model = (nativeId = 'native/model-a', protocols = [
  { family: 'wire-z', version: '2', capabilities: [
    { id: 'tools', version: 1, state: 'supported' as const },
    { id: 'stream', version: 2, state: 'unknown' as const },
  ] },
  { family: 'wire-a', version: '1', capabilities: [{ id: 'text', version: 1, state: 'supported' as const }] },
]) => ({ id: 'model-a', version: 2, nativeId, protocols });
const catalog = (revision = 'revision-a', models = [model()]) => ({ schemaVersion: 1 as const, revision,
  providers: [{ id: 'provider-a', version: 1, models }] });
type MutableDefinition = { encodingVersion: 1; provider: { id: string; version: number }; model: {
  id: string; version: number; nativeId: string; protocols: { family: string; version: string;
    capabilities: { id: string; version: number; state: 'supported' | 'unsupported' | 'unknown' }[] }[] } };

function encoded(input = catalog()) {
  const definition = resolveModelBindingDefinition(parseProviderCatalog(input), parseModelReference(ref));
  if (!definition) throw new Error('EXPECTED_DECLARED_MODEL');
  return encodeModelBindingDefinition(definition);
}

describe('model semantic binding', () => {
  it('has an independent golden versioned encoding vector', () => {
    expect(encoded()).toBe('deckent.model-binding.v1\n' +
      '{"encodingVersion":1,"model":{"id":"model-a","nativeId":"native/model-a","protocols":[' +
      '{"capabilities":[{"id":"text","state":"supported","version":1}],"family":"wire-a","version":"1"},' +
      '{"capabilities":[{"id":"stream","state":"unknown","version":2},{"id":"tools","state":"supported","version":1}],"family":"wire-z","version":"2"}' +
      '],"version":2},"provider":{"id":"provider-a","version":1}}');
  });

  it('is stable across declaration order, unrelated models and catalog revisions', () => {
    const baseline = encoded();
    const permuted = model('native/model-a', [
      { family: 'wire-a', version: '1', capabilities: [{ id: 'text', version: 1, state: 'supported' as const }] },
      { family: 'wire-z', version: '2', capabilities: [
        { id: 'stream', version: 2, state: 'unknown' as const },
        { id: 'tools', version: 1, state: 'supported' as const },
      ] },
    ]);
    expect(encoded(catalog('unrelated-revision', [
      { id: 'another', version: 1, nativeId: 'native/another', protocols: [{ family: 'other', version: '1', capabilities: [] }] },
      permuted,
    ]))).toBe(baseline);
  });

  it('changes bytes for each semantic field and does not normalize Unicode or capability states', () => {
    const definition = resolveModelBindingDefinition(parseProviderCatalog(catalog()), parseModelReference(ref));
    if (!definition) throw new Error('EXPECTED_DECLARED_MODEL');
    const baseline = encodeModelBindingDefinition(definition);
    const mutate = (change: (copy: MutableDefinition) => void) => {
      const copy = structuredClone(definition) as MutableDefinition; change(copy);
      return encodeModelBindingDefinition(copy);
    };
    for (const changed of [
      mutate(copy => { copy.model.nativeId = 'native/changed'; }),
      mutate(copy => { copy.model.protocols[0]!.family = 'wire-changed'; }),
      mutate(copy => { copy.model.protocols[0]!.version = 'changed'; }),
      mutate(copy => { copy.model.protocols[0]!.capabilities[0]!.id = 'changed'; }),
      mutate(copy => { copy.model.protocols[0]!.capabilities[0]!.version = 3; }),
      mutate(copy => { copy.model.protocols[0]!.capabilities[0]!.state = 'unsupported'; }),
      mutate(copy => { copy.provider.id = 'provider-changed'; }),
      mutate(copy => { copy.provider.version = 2; }),
      mutate(copy => { copy.model.id = 'model-changed'; }),
      mutate(copy => { copy.model.version = 3; }),
    ]) expect(changed).not.toBe(baseline);
    expect(baseline).toContain('"state":"unknown"');
    expect(mutate(copy => { copy.model.protocols[0]!.capabilities[0]!.state = 'unsupported'; })).toContain('"state":"unsupported"');
    const composed = mutate(copy => { copy.model.nativeId = 'native/\u00e9'; });
    const decomposed = mutate(copy => { copy.model.nativeId = 'native/e\u0301'; });
    expect(composed).not.toBe(decomposed);
  });

  it('returns null for every exact reference mismatch', () => {
    const admitted = parseProviderCatalog(catalog()), variants = [
      { ...ref, providerId: 'missing' }, { ...ref, providerVersion: 2 },
      { ...ref, modelId: 'missing' }, { ...ref, modelVersion: 3 },
    ];
    for (const candidate of variants) expect(resolveModelBindingDefinition(admitted, parseModelReference(candidate))).toBeNull();
  });

  it('strictly rejects invalid references without invoking getters or traversing cycles', () => {
    expect(() => parseModelReference({ ...ref, extra: true })).toThrow('PROVIDER_CATALOG_INVALID');
    expect(() => parseModelReference({ ...ref, providerVersion: 0 })).toThrow('PROVIDER_CATALOG_INVALID');
    let getterCalls = 0;
    const getter = Object.defineProperty({}, 'providerId', { enumerable: true, get() { getterCalls++; return 'provider-a'; } });
    expect(() => parseModelReference(getter)).toThrow('PROVIDER_CATALOG_INVALID');
    expect(getterCalls).toBe(0);
    const cyclic: Record<string, unknown> = { ...ref }; cyclic['cycle'] = cyclic;
    expect(() => parseModelReference(cyclic)).toThrow('PROVIDER_CATALOG_INVALID');
    let definitionGetterCalls = 0;
    const definitionGetter = Object.defineProperty({}, 'encodingVersion', { enumerable: true, get() { definitionGetterCalls++; return 1; } });
    expect(() => encodeModelBindingDefinition(definitionGetter)).toThrow('PROVIDER_CATALOG_INVALID');
    expect(definitionGetterCalls).toBe(0);
  });
});
