import { expect, it } from 'vitest';
import { ModelBindingApplication } from '../../../src/engine/core/provider-catalog/index.js';

const reference = { providerId: 'provider', providerVersion: 2, modelId: 'model', modelVersion: 3 };
const catalog = { schemaVersion: 1, revision: 'declared-1', providers: [{ id: 'provider', version: 2,
  models: [{ id: 'model', version: 3, nativeId: 'native/model', protocols: [{ family: 'native', version: 'v1', capabilities: [] }] }] }] };

it('hashes the versioned canonical UTF-8 definition against an independent golden vector', async () => {
  let reads = 0;
  const result = await new ModelBindingApplication({ async read() { reads++; return catalog; } }).inspect(reference);
  expect(result.status).toBe('declared');
  expect(result.binding).toEqual({ encodingVersion: 1, algorithm: 'sha256',
    digest: 'b0dc8a5d82596ec1d603579543466573753a50d72d47809e6a90bbb3a3add243' });
  expect(result.definition).toEqual({ encodingVersion: 1, provider: { id: 'provider', version: 2 }, model: catalog.providers[0]!.models[0] });
  expect(result.availability).toBe('not-observed'); expect(reads).toBe(1);
  expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.binding)).toBe(true);
  expect(Object.isFrozen(result.definition?.model.protocols)).toBe(true);
  catalog.revision = 'declared-2';
  const revised = await new ModelBindingApplication({ async read() { return catalog; } }).inspect(reference);
  expect(revised.binding).toEqual(result.binding); expect(revised.catalogRevision).toBe('declared-2');
  catalog.revision = 'declared-1';
});

it('distinguishes absent catalog and exact absent model without invoking an alternative', async () => {
  const absent = await new ModelBindingApplication({ async read() { return undefined; } }).inspect(reference);
  expect(absent).toEqual({ schemaVersion: 1, reference, availability: 'not-observed', status: 'not-configured',
    catalogRevision: null, definition: null, binding: null });
  const missing = await new ModelBindingApplication({ async read() { return catalog; } }).inspect({ ...reference, modelVersion: 4 });
  expect(missing).toMatchObject({ status: 'not-declared', catalogRevision: 'declared-1', definition: null, binding: null });
});

it('rejects malformed references before touching the source, and propagates source failures', async () => {
  let reads = 0, getters = 0;
  const application = new ModelBindingApplication({ async read() { reads++; return catalog; } });
  const input = Object.defineProperty({ ...reference }, 'providerId', { enumerable: true, get() { getters++; return 'provider'; } });
  await expect(application.inspect(input)).rejects.toThrow();
  await expect(application.inspect({ ...reference, modelVersion: 0 })).rejects.toThrow();
  expect(reads).toBe(0); expect(getters).toBe(0);
  const unavailable = new Error('fixture unavailable');
  await expect(new ModelBindingApplication({ async read() { throw unavailable; } }).inspect(reference)).rejects.toBe(unavailable);
});

it('rejects duplicate or invalid declarations instead of fingerprinting partial input', async () => {
  const duplicate = { ...catalog, providers: [...catalog.providers, ...catalog.providers] };
  await expect(new ModelBindingApplication({ async read() { return duplicate; } }).inspect(reference)).rejects.toThrow('PROVIDER_CATALOG_DUPLICATE');
  await expect(new ModelBindingApplication({ async read() { return { ...catalog, schemaVersion: 2 }; } }).inspect(reference)).rejects.toThrow('PROVIDER_CATALOG_INVALID');
});
