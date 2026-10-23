import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { MODEL_MAKERS, canonicalModelMaker, independentMakerRows, makersIndependent, parseProviderCatalogDocument } from '#domain/index.js';

// S4B-1 (MODEL-INDEPENDENCE-AUDIT M1 item 1, lead 2026-10-23): independence compares canonical makers from a small versioned registry, never raw
// catalog `vendorId` strings. An alias resolves to one maker; a provider-chosen entry (`selection: 'provider'`) or one without metadata is
// maker-unknown, so an independence check fails closed. The registry carries no tier or role (S2 `model_roles` stays their only owner).
const catalog = (name: string) => parseProviderCatalogDocument(JSON.parse(readFileSync(new URL(`../../../assets/model-catalog/${name}`, import.meta.url), 'utf8')));
const models = readdirSync(new URL('../../../assets/model-catalog/', import.meta.url)).flatMap(name => catalog(name).providers.flatMap(provider => provider.models));

it('maps the zai-cn-api vendor alias to the same canonical maker as zai-api', () => {
  const vendor = (id: string) => models.find(model => 'vendorId' in model && model.vendorId === id)!;
  expect(canonicalModelMaker(vendor('zhipu'))).toBe('zai');
  expect(canonicalModelMaker(vendor('zai'))).toBe('zai');
  expect(canonicalModelMaker(vendor('anthropic'))).toBe('anthropic');
  expect(MODEL_MAKERS.revision).toMatch(/^model-makers-/);
  expect(Object.keys(MODEL_MAKERS).sort()).toEqual(['aliases', 'revision', 'schemaVersion']);
});

it('a provider-chosen entry or one without metadata is maker-unknown, and independence then fails closed', () => {
  const auto = models.find(model => 'selection' in model && model.selection === 'provider')!;
  expect(auto).toBeDefined();
  expect(canonicalModelMaker(auto)).toBeNull();
  expect(canonicalModelMaker(null)).toBeNull();
  expect(canonicalModelMaker({ id: 'x' })).toBeNull();
  expect(makersIndependent('openai', ['anthropic'])).toBe(true);
  expect(makersIndependent('zai', ['zai'])).toBe(false);
  expect(makersIndependent('openai', ['anthropic', null])).toBe(false);
  expect(makersIndependent(null, ['anthropic'])).toBe(false);
  expect(makersIndependent('openai', [])).toBe(false);
});

it('every catalog vendor is either canonical or a registered alias of a canonical maker (no alias chains)', () => {
  const vendors = new Set(models.flatMap(model => 'vendorId' in model ? [model.vendorId] : []));
  for (const alias of Object.keys(MODEL_MAKERS.aliases)) expect(Object.keys(MODEL_MAKERS.aliases)).not.toContain(MODEL_MAKERS.aliases[alias]);
  expect([...vendors].every(vendor => typeof vendor === 'string' && vendor.length > 0)).toBe(true);
});

it('the independent rows follow the registry order and the catalog maker only: no model name decides it', () => {
  const rows = [{ channelId: 'a', modelId: 'x', vendorId: 'anthropic' }, { channelId: 'b', modelId: 'y', vendorId: 'openai' }, { channelId: 'c', modelId: 'z', vendorId: 'zhipu' },
    { channelId: 'd', modelId: 'auto', selection: 'provider' }];
  expect(independentMakerRows(rows, canonicalModelMaker, ['anthropic']).map(row => [row.channelId, row.maker])).toEqual([['b', 'openai'], ['c', 'zai']]);
  expect(independentMakerRows(rows, canonicalModelMaker, ['zai'])).toHaveLength(2);
  expect(independentMakerRows(rows, canonicalModelMaker, [null])).toEqual([]);
  expect(independentMakerRows(rows.slice(0, 1), canonicalModelMaker, ['anthropic'])).toEqual([]);
});
