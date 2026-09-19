import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createImmutableJsonObjectSchema, immutableJsonObjectSchema } from '../../../src/domain/core/primitives/index.js';
import { NATIVE_MODEL_ID_MAX_LENGTH, PROVIDER_CATALOG_WIRE_LIMITS, parseProviderCatalog,
  providerCatalogObjectSchema } from '../../../src/domain/core/provider-catalog/index.js';

const capability = (id: string, version = 1, state: 'supported' | 'unsupported' | 'unknown' = 'unknown') => ({ id, version, state });
const protocol = (family: string, version = '1', capabilities = [capability('tools')]) => ({ family, version, capabilities });
const model = (id: string, version = 1, protocols = [protocol('native')]) => ({ id, version, nativeId: `native/${id}`, protocols });
const provider = (id: string, version = 1, models = [model('model')]) => ({ id, version, models });
const catalog = (providers = [provider('provider')]) => ({ schemaVersion: 1, revision: 'revision-1', providers });

describe('provider catalog admission', () => {
  it('sorts every tuple scope by ordinal identity then version and deeply freezes the result', () => {
    const result = parseProviderCatalog(catalog([
      provider('z', 1, [model('b', 2, [protocol('wire', 'z', [capability('b', 2), capability('a', 1)]), protocol('wire', 'a')]), model('a')]),
      provider('a', 2), provider('a', 1),
    ]));
    expect(result.providers.map(value => [value.id, value.version])).toEqual([['a', 1], ['a', 2], ['z', 1]]);
    const selected = result.providers[2]!.models[1]!;
    expect(result.providers[2]!.models.map(value => value.id)).toEqual(['a', 'b']);
    expect(selected.protocols.map(value => value.version)).toEqual(['a', 'z']);
    expect(selected.protocols[1]!.capabilities.map(value => value.id)).toEqual(['a', 'b']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.providers)).toBe(true);
    expect(Object.isFrozen(selected.protocols[1]!.capabilities[0])).toBe(true);
  });

  it('accepts empty provider and model snapshots but requires a native protocol for every model', () => {
    expect(parseProviderCatalog(catalog([])).providers).toEqual([]);
    expect(parseProviderCatalog(catalog([provider('empty', 1, [])])).providers[0]!.models).toEqual([]);
    expect(() => parseProviderCatalog(catalog([provider('bad', 1, [model('missing', 1, [])])]))).toThrow('PROVIDER_CATALOG_INVALID');
  });

  it('rejects future versions, unknown fields, invalid native ids, getters and cycles with sanitized paths', () => {
    for (const [input, path] of [
      [{ ...catalog(), schemaVersion: 2 }, ['schemaVersion']],
      [{ ...catalog(), extra: true }, []],
      [catalog([provider('p', 1, [{ ...model('m'), nativeId: ` ${'x'.repeat(NATIVE_MODEL_ID_MAX_LENGTH)}` }])]), ['providers', 0, 'models', 0, 'nativeId']],
    ] as const) {
      try { parseProviderCatalog(input); expect.fail('must reject'); }
      catch (error) { expect(error).toMatchObject({ code: 'PROVIDER_CATALOG_INVALID', issues: expect.arrayContaining([expect.objectContaining({ path })]) }); }
    }
    let getterCalls = 0;
    const getter = Object.defineProperty({}, 'schemaVersion', { enumerable: true, get() { getterCalls++; return 1; } });
    expect(() => parseProviderCatalog(getter)).toThrow('PROVIDER_CATALOG_INVALID');
    expect(getterCalls).toBe(0);
    const cyclic: Record<string, unknown> = { schemaVersion: 1, revision: 'r', providers: [] }; cyclic.self = cyclic;
    expect(() => parseProviderCatalog(cyclic)).toThrow('PROVIDER_CATALOG_INVALID');
  });

  it('rejects duplicate exact tuples independently at all four scopes', () => {
    const cases = [
      catalog([provider('p'), provider('p')]),
      catalog([provider('p', 1, [model('m'), model('m')])]),
      catalog([provider('p', 1, [model('m', 1, [protocol('x'), protocol('x')])])]),
      catalog([provider('p', 1, [model('m', 1, [protocol('x', '1', [capability('c'), capability('c')])])])]),
    ];
    for (const input of cases) expect(() => parseProviderCatalog(input)).toThrow('PROVIDER_CATALOG_DUPLICATE');
    expect(parseProviderCatalog(catalog([provider('p', 1), provider('p', 2)]))).toBeDefined();
  });

  it('admits hundreds of declared models inside the explicit catalog document envelope', () => {
    const result = parseProviderCatalog(catalog([provider('bulk', 1,
      Array.from({ length: 750 }, (_, index) => model(`model-${String(index).padStart(4, '0')}`)))]));
    expect(result.providers[0]!.models).toHaveLength(750);
    expect(PROVIDER_CATALOG_WIRE_LIMITS).toEqual({ maxDepth: 16, maxNodes: 262_144, maxCodeUnits: 8 * 1024 * 1024 });
  });
});

describe('bounded immutable JSON schema factory', () => {
  it('keeps existing defaults and enforces caller-specific node, text and depth budgets', () => {
    expect(immutableJsonObjectSchema.parse({ nested: { value: 'ok' } })).toEqual({ nested: { value: 'ok' } });
    expect(() => createImmutableJsonObjectSchema({ maxDepth: 1, maxNodes: 10, maxCodeUnits: 10 }).parse({ nested: { value: 1 } })).toThrow();
    expect(() => createImmutableJsonObjectSchema({ maxDepth: 4, maxNodes: 2, maxCodeUnits: 10 }).parse({ a: 1, b: 2 })).toThrow();
    expect(() => createImmutableJsonObjectSchema({ maxDepth: 4, maxNodes: 10, maxCodeUnits: 2 }).parse({ abc: 1 })).toThrow();
    expect(() => createImmutableJsonObjectSchema({ maxDepth: 0, maxNodes: 1, maxCodeUnits: 1 })).toThrow('JSON_VALUE_LIMITS_INVALID');
  });

  it('exposes a registry-compatible strict structural object schema', () => {
    expect(providerCatalogObjectSchema).toBeInstanceOf(z.ZodObject);
    expect(providerCatalogObjectSchema._def.unknownKeys).toBe('strict');
    expect(providerCatalogObjectSchema.safeParse(catalog()).success).toBe(true);
    expect(providerCatalogObjectSchema.safeParse({ ...catalog(), unknown: true }).success).toBe(false);
  });
});
